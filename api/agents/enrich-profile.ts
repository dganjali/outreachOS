import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { MODEL, WEB_SEARCH_TOOL, generateJsonWithSearch } from '../_lib/llm';
import { PROFILE_ENRICH_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';
import { embedOne } from '../_lib/embeddings';
import { apolloEnabled, matchPerson, fullName, type ApolloPerson } from '../_lib/apollo';
import type { ContextFactDoc, ProfileDoc } from '../../shared/schemas';

// Cap on how many facts a single enrichment can add — keeps the context bank
// from ballooning and the embed loop bounded.
const MAX_ENRICH_FACTS = 20;

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

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const profile = await scope.collection<ProfileDoc>('profiles').findOne();
  if (!profile) return res.status(404).json({ error: 'profile_not_found' });

  const linkedinUrl = pickLinkedinUrl(profile.linkedinUrl, profile.resumeUrl);
  if (!linkedinUrl && !profile.name) {
    return res.status(400).json({ error: 'no_linkedin_or_name' });
  }

  const useApollo = apolloEnabled() && !!linkedinUrl;
  const run = await startRun(scope, {
    agentType: 'enrich_profile',
    input: { source: useApollo ? 'apollo' : 'web_search', linkedin_url: linkedinUrl },
  });

  try {
    let apolloPerson: ApolloPerson | null = null;
    if (useApollo) {
      try {
        apolloPerson = await matchPerson({ linkedin_url: linkedinUrl! });
      } catch (err) {
        console.error('apollo_match_failed', err);
      }
    }

    const llmResult = await runLlmEnrichment({ profile, linkedinUrl, apolloPerson });

    const linkedinData = apolloPerson
      ? compactApollo(apolloPerson)
      : { headline: llmResult.headline ?? null, links: llmResult.links ?? [] };

    const updates: Partial<ProfileDoc> = {
      bio: llmResult.bio || profile.bio,
      proofPoints: llmResult.proof_points || profile.proofPoints,
      achievements: llmResult.achievements || profile.achievements,
      metrics: llmResult.metrics || profile.metrics,
      writingTone: llmResult.writing_tone || profile.writingTone,
      linkedinData,
      linkedinEnrichedAt: new Date(),
      linkedinSource: apolloPerson ? 'apollo' : 'web_search',
    };
    if (!profile.role && (apolloPerson?.title || llmResult.current_role)) {
      updates.role = apolloPerson?.title ?? llmResult.current_role ?? null;
    }
    if (!profile.organization && (apolloPerson?.organization?.name || llmResult.current_organization)) {
      updates.organization = apolloPerson?.organization?.name ?? llmResult.current_organization ?? null;
    }

    await scope.collection<ProfileDoc>('profiles').updateById(profile._id, updates);
    const updated = await scope.collection<ProfileDoc>('profiles').findById(profile._id);

    // Turn the enrichment into atomic, person-level context facts — the actual
    // grounding source the drafting engine reads. Without this the LinkedIn URL
    // collected at onboarding never reaches a draft.
    const factsAdded = await persistEnrichmentFacts(scope, {
      proofPoints: llmResult.proof_points,
      achievements: llmResult.achievements,
      metrics: llmResult.metrics,
    });

    await completeRun(scope, run._id, {
      source: apolloPerson ? 'apollo' : 'web_search',
      fields_filled: Object.keys(updates).length,
      facts_added: factsAdded,
    });
    return res.status(200).json({
      run_id: run._id,
      profile: updated,
      source: apolloPerson ? 'apollo' : 'web_search',
      facts_added: factsAdded,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

async function runLlmEnrichment(args: {
  profile: ProfileDoc;
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
      ].filter(Boolean).join('\n')
    : '';

  const userPrompt = [
    `SENDER (you are summarizing this person)`,
    `Name: ${profile.name ?? 'Unknown'}`,
    profile.role ? `Stated role: ${profile.role}` : '',
    profile.organization ? `Stated org: ${profile.organization}` : '',
    linkedinUrl ? `LinkedIn: ${linkedinUrl}` : '',
    profile.resumeUrl && profile.resumeUrl !== linkedinUrl ? `Resume: ${profile.resumeUrl}` : '',
    profile.website ? `Website: ${profile.website}` : '',
    profile.portfolioLinks?.length ? `Portfolio:\n${profile.portfolioLinks.join('\n')}` : '',
    '',
    apolloBlock,
    '',
    'Use web_search to verify and surface concrete proof points. JSON only.',
  ].filter(Boolean).join('\n');

  const parsed = await generateJsonWithSearch<EnrichmentOutput>({
    model: MODEL(),
    max_tokens: 2048,
    system: PROFILE_ENRICH_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });
  if (!parsed.ok || !parsed.data) throw new Error('parse_failed');
  return parsed.data;
}

/**
 * Split the enrichment's list-shaped fields into atomic claims and persist them
 * as person-level context facts (deduped against what's already there, embedded
 * best-effort). Returns the number actually inserted.
 */
async function persistEnrichmentFacts(
  scope: ReturnType<typeof forUser>,
  fields: { proofPoints?: string; achievements?: string; metrics?: string }
): Promise<number> {
  const candidates: Array<{ claim: string; type: ContextFactDoc['type'] }> = [
    ...splitClaims(fields.proofPoints).map((claim) => ({ claim, type: 'proof' as const })),
    ...splitClaims(fields.achievements).map((claim) => ({ claim, type: 'proof' as const })),
    ...splitClaims(fields.metrics).map((claim) => ({ claim, type: 'metric' as const })),
  ];
  if (candidates.length === 0) return 0;

  const existing = await scope
    .collection<ContextFactDoc>('context_facts')
    .find({ scope: 'person' } as Record<string, unknown>);
  const seen = new Set(existing.map((f) => f.claim.toLowerCase().trim()));

  let inserted = 0;
  for (const c of candidates) {
    if (inserted >= MAX_ENRICH_FACTS) break;
    const key = c.claim.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);

    let embedding: number[] | undefined;
    try {
      embedding = await embedOne(c.claim, 'document');
    } catch {
      // Best-effort — facts are still useful without a vector (recency fallback).
    }

    const doc: InsertDoc<ContextFactDoc> = {
      _id: newId(),
      scope: 'person',
      personaId: null,
      type: c.type,
      claim: c.claim,
      date: null,
      evidenceUrl: null,
      provenance: 'enrich',
      confidence: 0.6, // web-sourced — lower than user-entered, the user can prune
      ...(embedding ? { embedding } : {}),
    };
    await scope.collection<ContextFactDoc>('context_facts').insertOne(doc);
    inserted += 1;
  }
  return inserted;
}

/**
 * Best-effort split of a "comma- or newline-separated list" field into atomic
 * claims. Splits on newlines, semicolons, and bullets; drops list markers and
 * fragments too short to be a real, citable fact.
 */
function splitClaims(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n;•]+/)
    .map((s) => s.replace(/^[\s•\-*\d.)]+/, '').trim())
    .filter((s) => s.length >= 8 && s.length <= 300);
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
      p.employment_history?.slice(0, 8).map((h) => ({
        title: h.title ?? null,
        organization: h.organization_name ?? null,
        start_date: h.start_date ?? null,
        end_date: h.end_date ?? null,
        current: !!h.current,
      })) ?? [],
  };
}
