import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { PROFILE_ENRICH_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';
import { apolloEnabled, matchPerson, fullName, type ApolloPerson } from '../_lib/apollo';

interface EnrichmentOutput {
  bio: string;
  proof_points: string;
  achievements: string;
  metrics: string;
  writing_tone: string;
  headline?: string | null;
  current_role?: string | null;
  current_organization?: string | null;
  links?: string[];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const db = adminClient();
  const { data: profile, error: pErr } = await db
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .single();
  if (pErr || !profile) return res.status(404).json({ error: 'profile_not_found' });

  const linkedinUrl = pickLinkedinUrl(profile.linkedin_url, profile.resume_url);
  if (!linkedinUrl && !profile.name) {
    return res.status(400).json({ error: 'no_linkedin_or_name' });
  }

  const useApollo = apolloEnabled() && !!linkedinUrl;
  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'enrich_profile',
    input: { source: useApollo ? 'apollo' : 'web_search', linkedin_url: linkedinUrl },
  });

  try {
    let apolloPerson: ApolloPerson | null = null;
    if (useApollo) {
      try {
        apolloPerson = await matchPerson({ linkedin_url: linkedinUrl! });
      } catch (err) {
        // Soft-fail: keep going with web_search-only enrichment.
        console.error('apollo_match_failed', err);
      }
    }

    const llmResult = await runLlmEnrichment({ profile, linkedinUrl, apolloPerson });

    const linkedinData = apolloPerson
      ? compactApollo(apolloPerson)
      : { headline: llmResult.headline ?? null, links: llmResult.links ?? [] };

    const updates: Record<string, unknown> = {
      bio: llmResult.bio || profile.bio,
      proof_points: llmResult.proof_points || profile.proof_points,
      achievements: llmResult.achievements || profile.achievements,
      metrics: llmResult.metrics || profile.metrics,
      writing_tone: llmResult.writing_tone || profile.writing_tone,
      linkedin_data: linkedinData,
      linkedin_enriched_at: new Date().toISOString(),
      linkedin_source: apolloPerson ? 'apollo' : 'web_search',
      updated_at: new Date().toISOString(),
    };
    if (!profile.role && (apolloPerson?.title || llmResult.current_role)) {
      updates.role = apolloPerson?.title ?? llmResult.current_role;
    }
    if (!profile.organization && (apolloPerson?.organization?.name || llmResult.current_organization)) {
      updates.organization = apolloPerson?.organization?.name ?? llmResult.current_organization;
    }

    const { data: updated, error: uErr } = await db
      .from('profiles')
      .update(updates)
      .eq('user_id', user.id)
      .select('*')
      .single();
    if (uErr) {
      await failRun(db, run.id, uErr.message);
      return res.status(500).json({ error: 'update_failed', detail: uErr.message });
    }

    await completeRun(db, run.id, {
      source: apolloPerson ? 'apollo' : 'web_search',
      fields_filled: Object.keys(updates).filter((k) => k !== 'updated_at').length,
    });
    return res.status(200).json({
      run_id: run.id,
      profile: updated,
      source: apolloPerson ? 'apollo' : 'web_search',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

async function runLlmEnrichment(args: {
  profile: { name: string | null; role: string | null; organization: string | null; resume_url: string | null; website: string | null; portfolio_links: string[] | null };
  linkedinUrl: string | null;
  apolloPerson: ApolloPerson | null;
}): Promise<EnrichmentOutput> {
  const { profile, linkedinUrl, apolloPerson } = args;

  const apolloBlock = apolloPerson
    ? [
        `APOLLO PROFILE`,
        `Name: ${fullName(apolloPerson)}`,
        apolloPerson.title ? `Title: ${apolloPerson.title}` : '',
        apolloPerson.headline ? `Headline: ${apolloPerson.headline}` : '',
        apolloPerson.organization?.name ? `Org: ${apolloPerson.organization.name}` : '',
        apolloPerson.linkedin_url ? `LinkedIn: ${apolloPerson.linkedin_url}` : '',
        apolloPerson.employment_history?.length
          ? `History:\n${apolloPerson.employment_history
              .slice(0, 6)
              .map((h) => `- ${h.title ?? ''} @ ${h.organization_name ?? ''}${h.current ? ' (current)' : ''}`)
              .join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const userPrompt = [
    `SENDER (you are summarizing this person)`,
    `Name: ${profile.name ?? 'Unknown'}`,
    profile.role ? `Stated role: ${profile.role}` : '',
    profile.organization ? `Stated org: ${profile.organization}` : '',
    linkedinUrl ? `LinkedIn: ${linkedinUrl}` : '',
    profile.resume_url && profile.resume_url !== linkedinUrl ? `Resume: ${profile.resume_url}` : '',
    profile.website ? `Website: ${profile.website}` : '',
    profile.portfolio_links?.length ? `Portfolio:\n${profile.portfolio_links.join('\n')}` : '',
    '',
    apolloBlock,
    '',
    'Use web_search to verify and surface concrete proof points. JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const message = await anthropic().messages.create({
    model: MODEL(),
    max_tokens: 2048,
    system: PROFILE_ENRICH_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = extractJson<EnrichmentOutput>(message);
  if (!parsed.ok || !parsed.data) {
    throw new Error('parse_failed');
  }
  return parsed.data;
}

function pickLinkedinUrl(linkedinUrl: string | null, resumeUrl: string | null): string | null {
  if (linkedinUrl && /linkedin\.com/i.test(linkedinUrl)) return linkedinUrl;
  if (resumeUrl && /linkedin\.com/i.test(resumeUrl)) return resumeUrl;
  return linkedinUrl;
}

function compactApollo(p: ApolloPerson): Record<string, unknown> {
  return {
    apollo_person_id: p.id ?? null,
    name: fullName(p),
    title: p.title ?? null,
    headline: p.headline ?? null,
    linkedin_url: p.linkedin_url ?? null,
    seniority: p.seniority ?? null,
    location: [p.city, p.state, p.country].filter(Boolean).join(', ') || null,
    organization: p.organization
      ? {
          name: p.organization.name,
          domain: p.organization.primary_domain,
          industry: p.organization.industry,
          employees: p.organization.estimated_num_employees,
        }
      : null,
    employment_history:
      p.employment_history
        ?.slice(0, 8)
        .map((h) => ({
          title: h.title ?? null,
          organization: h.organization_name ?? null,
          start_date: h.start_date ?? null,
          end_date: h.end_date ?? null,
          current: !!h.current,
        })) ?? [],
  };
}
