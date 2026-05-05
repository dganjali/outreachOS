import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import {
  TARGETING_SYSTEM,
  TARGETING_FILTER_SYSTEM,
  TARGETING_RANK_SYSTEM,
  type MissionMode,
} from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';
import {
  apolloEnabled,
  searchOrganizations,
  type ApolloOrganization,
  type OrgSearchFilters,
} from '../_lib/apollo';
import { createMessageWithRetry, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { TARGETING_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';

interface TargetSuggestion {
  company_name: string;
  domain: string | null;
  score: number;
  why_now: string;
  fit_reason: string;
  signal_type: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  if (!await checkRateLimit(adminClient(), res, user.id)) return;

  const { mission_id, count } = (req.body ?? {}) as { mission_id?: string; count?: number };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

  const db = adminClient();
  const { data: mission, error: mErr } = await db
    .from('missions')
    .select('*')
    .eq('id', mission_id)
    .eq('user_id', user.id)
    .single();
  if (mErr || !mission) return res.status(404).json({ error: 'mission_not_found' });

  const { data: profile } = await db
    .from('profiles')
    .select('name, role, organization, bio, proof_points')
    .eq('user_id', user.id)
    .single();

  const desired = Math.min(Math.max(count ?? 10, 1), 25);
  const useApollo = apolloEnabled();

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'targeting',
    mission_id,
    input: { count: desired, source: useApollo ? 'apollo' : 'web_search' },
  });

  const mode = (mission.mode as MissionMode | null) ?? 'sales';

  try {
    let rows: Array<Record<string, unknown>>;
    if (useApollo) {
      rows = await runApolloHybrid({ mission, mode, desired, profile, mission_id });
    } else {
      rows = await runWebSearchOnly({ mission, mode, desired, profile, mission_id });
    }

    if (rows.length === 0) {
      await failRun(db, run.id, 'no_targets_found');
      return res.status(502).json({ error: 'no_targets_found' });
    }

    const { data: inserted, error: insErr } = await db
      .from('targets')
      .insert(rows)
      .select('*');
    if (insErr) {
      await failRun(db, run.id, insErr.message);
      return res.status(500).json({ error: 'insert_failed', detail: insErr.message });
    }

    await completeRun(db, run.id, {
      count: inserted?.length ?? 0,
      source: useApollo ? 'apollo' : 'web_search',
    });
    return res.status(200).json({
      run_id: run.id,
      targets: inserted,
      source: useApollo ? 'apollo' : 'web_search',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

async function runWebSearchOnly(args: {
  mission: { name: string; goal: string; target_description: string };
  mode: MissionMode;
  desired: number;
  profile: { name?: string | null; role?: string | null; organization?: string | null; proof_points?: string | null } | null;
  mission_id: string;
}): Promise<Array<Record<string, unknown>>> {
  const { mission, mode, desired, profile, mission_id } = args;
  const userPrompt = [
    `Mission: ${mission.name}`,
    `Mode: ${mode}`,
    `What I'm sending / offer: ${mission.goal}`,
    `Target description (the why): ${mission.target_description}`,
    profile?.name
      ? `Sender: ${profile.name}${profile.role ? `, ${profile.role}` : ''}${
          profile.organization ? ` at ${profile.organization}` : ''
        }`
      : '',
    profile?.proof_points ? `Sender credibility: ${profile.proof_points}` : '',
    '',
    `Find ${desired} target organizations with strong recent "why now" signals. Use web_search.`,
    'Return JSON only, no commentary.',
  ]
    .filter(Boolean)
    .join('\n');

  const message = await anthropic().messages.create({
    model: MODEL(),
    max_tokens: 4096,
    system: TARGETING_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = extractJson<{ targets: TargetSuggestion[] }>(message);
  if (!parsed.ok || !parsed.data?.targets) {
    throw new Error('parse_failed');
  }

  return parsed.data.targets.slice(0, 25).map((t) => ({
    mission_id,
    company_name: t.company_name,
    domain: t.domain,
    score: clamp(t.score, 0, 100),
    why_now: t.why_now,
    fit_reason: t.fit_reason,
    signal_type: t.signal_type,
    status: 'suggested',
    source: 'web_search',
  }));
}

async function runApolloHybrid(args: {
  mission: { name: string; goal: string; target_description: string };
  mode: MissionMode;
  desired: number;
  profile: { name?: string | null; role?: string | null; organization?: string | null; proof_points?: string | null } | null;
  mission_id: string;
}): Promise<Array<Record<string, unknown>>> {
  const { mission, mode, desired, profile, mission_id } = args;

  // Step 1: derive Apollo filters
  const filterPrompt = [
    `Mission name: ${mission.name}`,
    `Mode: ${mode}`,
    `Offer: ${mission.goal}`,
    `Audience: ${mission.target_description}`,
    profile?.organization ? `Sender org (don't target): ${profile.organization}` : '',
    '',
    'Output Apollo filters as JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const filterMsg = await anthropic().messages.create({
    model: MODEL(),
    max_tokens: 512,
    system: TARGETING_FILTER_SYSTEM,
    messages: [{ role: 'user', content: filterPrompt }],
  });
  const filterParsed = extractJson<OrgSearchFilters>(filterMsg);
  const filters: OrgSearchFilters = filterParsed.ok && filterParsed.data ? filterParsed.data : {};

  // Step 2: pull a wider candidate pool from Apollo than we need
  const perPage = Math.min(Math.max(desired * 3, 20), 50);
  let candidates: ApolloOrganization[];
  try {
    candidates = await searchOrganizations({ ...filters, per_page: perPage });
  } catch (err) {
    // If Apollo errors at runtime, fall back to web_search rather than failing the user.
    console.error('apollo_search_failed', err);
    return runWebSearchOnly(args);
  }
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 4096,
      system: TARGETING_SYSTEM,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: userPrompt }],
    });

  if (candidates.length === 0) {
    // Apollo returned nothing for these filters — fall back so the user still gets results.
    return runWebSearchOnly(args);
  }

  const sender = profile?.organization?.trim().toLowerCase();
  const trimmed = candidates
    .filter((o) => o.name && (!sender || o.name.toLowerCase() !== sender))
    .slice(0, perPage);

  // Step 3: rank + add why_now via LLM with web_search
  const candidateList = trimmed.map((o, i) => ({
    idx: i,
    company_name: o.name,
    domain: o.primary_domain ?? domainFromUrl(o.website_url),
    industry: o.industry,
    employees: o.estimated_num_employees,
    location: [o.city, o.state, o.country].filter(Boolean).join(', '),
    funding_stage: o.latest_funding_stage,
    funding_date: o.latest_funding_round_date,
    short_description: o.short_description,
    keywords: o.keywords?.slice(0, 8),
    technologies: o.technology_names?.slice(0, 8),
  }));

  const rankPrompt = [
    `Mission: ${mission.name}`,
    `Mode: ${mode}`,
    `Offer: ${mission.goal}`,
    `Audience: ${mission.target_description}`,
    profile?.proof_points ? `Sender credibility: ${profile.proof_points}` : '',
    '',
    `Apollo candidates (${trimmed.length}):`,
    JSON.stringify(candidateList, null, 2),
    '',
    `Pick the top ${desired} for this mission. Use web_search to confirm or surface a recent "why now" signal for each. Return JSON only.`,
  ]
    .filter(Boolean)
    .join('\n');

  const rankMsg = await anthropic().messages.create({
    model: MODEL(),
    max_tokens: 4096,
    system: TARGETING_RANK_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: rankPrompt }],
  });

  const rankParsed = extractJson<{ targets: TargetSuggestion[] }>(rankMsg);
  if (!rankParsed.ok || !rankParsed.data?.targets) {
    // Worst case: drop the LLM rank and just insert top Apollo candidates with no why_now.
    return trimmed.slice(0, desired).map((o) => ({
      mission_id,
      company_name: o.name!,
      domain: o.primary_domain ?? domainFromUrl(o.website_url) ?? null,
      score: null,
      why_now: null,
      fit_reason: o.short_description ?? null,
      signal_type: null,
      status: 'suggested',
      source: 'apollo',
      apollo_organization_id: o.id ?? null,
      industry: o.industry ?? null,
      employee_count: o.estimated_num_employees ?? null,
      headquarters_location: [o.city, o.state, o.country].filter(Boolean).join(', ') || null,
    }));
  }

  // Re-attach Apollo metadata by name match (case-insensitive).
  const byName = new Map(trimmed.map((o) => [o.name?.toLowerCase() ?? '', o]));
  return rankParsed.data.targets.slice(0, desired).map((t) => {
    const apollo = byName.get(t.company_name.toLowerCase());
    return {
      mission_id,
      company_name: t.company_name,
      domain: t.domain ?? apollo?.primary_domain ?? domainFromUrl(apollo?.website_url) ?? null,
      score: clamp(t.score, 0, 100),
      why_now: t.why_now,
      fit_reason: t.fit_reason,
      signal_type: t.signal_type,
      status: 'suggested',
      source: 'apollo',
      apollo_organization_id: apollo?.id ?? null,
      industry: apollo?.industry ?? null,
      employee_count: apollo?.estimated_num_employees ?? null,
      headquarters_location: apollo
        ? [apollo.city, apollo.state, apollo.country].filter(Boolean).join(', ') || null
        : null,
    };
  });
}

function clamp(n: number, lo: number, hi: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function domainFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
