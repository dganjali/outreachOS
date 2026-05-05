import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import {
  CONTACTS_SYSTEM,
  CONTACTS_RANK_SYSTEM,
  type MissionMode,
} from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';
import {
  apolloEnabled,
  searchPeople,
  fullName,
  normalizeEmailStatus,
  type ApolloPerson,
} from '../_lib/apollo';

interface ContactSuggestion {
  name: string;
  role: string;
  linkedin_url: string | null;
  email: string | null;
  likely_email_pattern: string | null;
  confidence: number;
  reasoning: string;
}

interface ApolloContactRanked {
  apollo_person_id: string;
  name: string;
  role: string;
  linkedin_url: string | null;
  email: string | null;
  email_status: 'verified' | 'likely' | 'guessed' | 'none';
  seniority: string | null;
  headline: string | null;
  location: string | null;
  confidence: number;
  reasoning: string;
}

const TITLE_HINTS_BY_MODE: Record<MissionMode, string[]> = {
  sponsorship: [
    'developer relations', 'devrel', 'community', 'partnerships', 'brand',
    'marketing', 'events', 'developer marketing', 'ecosystem',
  ],
  bd: [
    'business development', 'partnerships', 'alliances', 'strategic partnerships',
    'corporate development', 'integrations',
  ],
  internship: [
    'engineering manager', 'recruiter', 'university', 'talent', 'hiring manager',
    'head of engineering', 'technical recruiter',
  ],
  recruiting: [
    'engineering manager', 'head of engineering', 'cto', 'vp engineering',
    'director of engineering', 'recruiter', 'talent',
  ],
  sales: [
    'head', 'director', 'vp', 'cto', 'cio', 'engineering manager',
    'product manager', 'operations',
  ],
};

const SENIORITIES_BY_MODE: Record<MissionMode, string[]> = {
  sponsorship: ['c_suite', 'vp', 'director', 'head', 'manager'],
  bd: ['c_suite', 'vp', 'director', 'head'],
  internship: ['vp', 'director', 'head', 'manager', 'senior'],
  recruiting: ['c_suite', 'vp', 'director', 'head', 'manager'],
  sales: ['c_suite', 'vp', 'director', 'head', 'manager'],
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const { target_id } = (req.body ?? {}) as { target_id?: string };
  if (!target_id) return res.status(400).json({ error: 'missing_target_id' });

  const db = adminClient();
  const { data: target, error: tErr } = await db
    .from('targets')
    .select('*, missions!inner(*)')
    .eq('id', target_id)
    .eq('missions.user_id', user.id)
    .single();
  if (tErr || !target) return res.status(404).json({ error: 'target_not_found' });

  const mission = target.missions as {
    id: string;
    name: string;
    goal: string;
    mode: MissionMode | null;
    target_description: string;
  };

  const mode = mission.mode ?? 'sales';
  const useApollo = apolloEnabled() && !!target.domain;

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'contacts',
    mission_id: mission.id,
    target_id,
    input: { source: useApollo ? 'apollo' : 'web_search' },
  });

  try {
    let rows: Array<Record<string, unknown>>;
    if (useApollo) {
      rows = await runApolloHybrid({ target, mission, mode, target_id });
    } else {
      rows = await runWebSearchOnly({ target, mission, mode, target_id });
    }

    if (rows.length === 0) {
      await failRun(db, run.id, 'no_contacts_found');
      return res.status(502).json({ error: 'no_contacts_found' });
    }

    const { data: inserted, error: insErr } = await db
      .from('contacts')
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
      contacts: inserted,
      source: useApollo ? 'apollo' : 'web_search',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

async function runWebSearchOnly(args: {
  target: { id: string; company_name: string; domain: string | null; why_now: string | null; fit_reason: string | null };
  mission: { goal: string; target_description: string };
  mode: MissionMode;
  target_id: string;
}): Promise<Array<Record<string, unknown>>> {
  const { target, mission, mode, target_id } = args;
  const userPrompt = [
    `Target organization: ${target.company_name}${target.domain ? ` (${target.domain})` : ''}`,
    `Mission mode: ${mode}`,
    `What's being offered: ${mission.goal}`,
    `Why this target: ${target.fit_reason ?? mission.target_description}`,
    target.why_now ? `Why now: ${target.why_now}` : '',
    '',
    'Find the 2-4 best people to contact. Use web_search on company site, LinkedIn public pages, press, blog. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const message = await anthropic().messages.create({
    model: MODEL(),
    max_tokens: 2048,
    system: CONTACTS_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = extractJson<{ contacts: ContactSuggestion[] }>(message);
  if (!parsed.ok || !parsed.data?.contacts) throw new Error('parse_failed');

  return parsed.data.contacts.slice(0, 6).map((c) => ({
    target_id,
    name: c.name,
    role: c.role,
    email: c.email ?? null,
    email_status: c.email ? 'guessed' : 'none',
    linkedin_url: c.linkedin_url,
    likely_email_pattern: c.likely_email_pattern,
    confidence: clamp01(c.confidence),
    reasoning: c.reasoning,
    status: 'suggested',
    source: 'web_search',
  }));
}

async function runApolloHybrid(args: {
  target: { id: string; company_name: string; domain: string | null; why_now: string | null; fit_reason: string | null };
  mission: { goal: string; target_description: string };
  mode: MissionMode;
  target_id: string;
}): Promise<Array<Record<string, unknown>>> {
  const { target, mission, mode, target_id } = args;
  const titles = TITLE_HINTS_BY_MODE[mode];
  const seniorities = SENIORITIES_BY_MODE[mode];

  let people: ApolloPerson[];
  try {
    people = await searchPeople({
      q_organization_domains: target.domain!,
      person_titles: titles,
      person_seniorities: seniorities,
      contact_email_status: ['verified', 'likely_to_engage'],
      per_page: 25,
    });
  } catch (err) {
    console.error('apollo_people_failed', err);
    return runWebSearchOnly(args);
  }

  if (people.length === 0) {
    return runWebSearchOnly(args);
  }

  // Compact the people list for the LLM (full Apollo objects are too noisy).
  const list = people.slice(0, 25).map((p) => ({
    apollo_person_id: p.id,
    name: fullName(p),
    role: p.title,
    headline: p.headline,
    linkedin_url: p.linkedin_url,
    email: p.email,
    email_status: normalizeEmailStatus(p.email_status),
    seniority: p.seniority,
    departments: p.departments,
    location: [p.city, p.state, p.country].filter(Boolean).join(', ') || null,
  }));

  const rankPrompt = [
    `TARGET ORGANIZATION`,
    `${target.company_name} (${target.domain})`,
    target.why_now ? `Why now: ${target.why_now}` : '',
    target.fit_reason ? `Fit: ${target.fit_reason}` : '',
    '',
    `MISSION`,
    `Mode: ${mode}`,
    `Offer: ${mission.goal}`,
    `Audience: ${mission.target_description}`,
    '',
    `APOLLO CANDIDATES (${list.length}):`,
    JSON.stringify(list, null, 2),
    '',
    'Pick the 2-4 best fits. Preserve apollo_person_id and email/email_status verbatim. JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const rankMsg = await anthropic().messages.create({
    model: MODEL(),
    max_tokens: 2048,
    system: CONTACTS_RANK_SYSTEM,
    messages: [{ role: 'user', content: rankPrompt }],
  });

  const rankParsed = extractJson<{ contacts: ApolloContactRanked[] }>(rankMsg);
  if (!rankParsed.ok || !rankParsed.data?.contacts) {
    // Fallback: take top 3 Apollo results without LLM ranking.
    return list.slice(0, 3).map((p) => ({
      target_id,
      name: p.name,
      role: p.role ?? p.headline ?? 'Unknown',
      email: p.email ?? null,
      email_status: p.email_status,
      linkedin_url: p.linkedin_url ?? null,
      likely_email_pattern: null,
      confidence: 0.6,
      reasoning: 'Top Apollo match by title and seniority.',
      status: 'suggested',
      source: 'apollo',
      apollo_person_id: p.apollo_person_id ?? null,
      seniority: p.seniority ?? null,
      headline: p.headline ?? null,
      location: p.location ?? null,
    }));
  }

  // Re-attach raw Apollo data by id to ensure email_status & email aren't fabricated.
  const byId = new Map(list.map((p) => [p.apollo_person_id ?? '', p]));
  return rankParsed.data.contacts.slice(0, 4).map((c) => {
    const apollo = byId.get(c.apollo_person_id ?? '');
    return {
      target_id,
      name: c.name,
      role: c.role,
      email: apollo?.email ?? c.email ?? null,
      email_status: apollo?.email_status ?? c.email_status ?? 'none',
      linkedin_url: apollo?.linkedin_url ?? c.linkedin_url ?? null,
      likely_email_pattern: null,
      confidence: clamp01(c.confidence),
      reasoning: c.reasoning,
      status: 'suggested',
      source: 'apollo',
      apollo_person_id: c.apollo_person_id ?? null,
      seniority: apollo?.seniority ?? c.seniority ?? null,
      headline: apollo?.headline ?? c.headline ?? null,
      location: apollo?.location ?? c.location ?? null,
    };
  });
}

function clamp01(n: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
