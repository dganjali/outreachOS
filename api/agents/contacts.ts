import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { createMessageWithRetry, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { CONTACTS_SYSTEM, CONTACTS_RANK_SYSTEM, CONTACTS_FROM_SERP_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import {
  apolloEnabled,
  searchPeople,
  fullName,
  normalizeEmailStatus,
  type ApolloPerson,
} from '../_lib/apollo';
import { resolveCompanyDomain } from '../_lib/company-enrich';
import { serperEnabled, searchPeople as serperSearchPeople } from '../_lib/serper';
import { resolveEmail, type ContactEmailFields, type ResolvedEmail } from '../_lib/email-resolver';
import { scrapeCompanyEmails, type ScrapeResult } from '../_lib/web-scrape';
import {
  isExcludedName,
  normalizeDomain,
  senderContextLines,
  senderExclusions,
} from '../_lib/sender-context';
import type { ContactDoc, MissionDoc, ProfileDoc, TargetDoc } from '../../shared/schemas';

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

// Loop-for-another-contact budget. Discovery hands the resolver a ranked
// candidate pool; the resolver walks it top-down keeping deliverable rows until
// it has TARGET_DELIVERABLE of them or has attempted RESOLVE_ATTEMPT_CAP
// candidates (the per-target cost ceiling — finder/verifier calls cost credits).
const TARGET_DELIVERABLE = 3;
const RESOLVE_ATTEMPT_CAP = 8;
const CANDIDATE_POOL_CAP = 10;

const TITLE_HINTS_BY_MODE: Record<MissionMode, string[]> = {
  sponsorship: ['developer relations', 'devrel', 'community', 'partnerships', 'brand', 'marketing', 'events', 'developer marketing', 'ecosystem'],
  bd: ['business development', 'partnerships', 'alliances', 'strategic partnerships', 'corporate development', 'integrations'],
  internship: ['engineering manager', 'recruiter', 'university', 'talent', 'hiring manager', 'head of engineering', 'technical recruiter'],
  recruiting: ['engineering manager', 'head of engineering', 'cto', 'vp engineering', 'director of engineering', 'recruiter', 'talent'],
  sales: ['head', 'director', 'vp', 'cto', 'cio', 'engineering manager', 'product manager', 'operations'],
};

const SENIORITIES_BY_MODE: Record<MissionMode, string[]> = {
  sponsorship: ['c_suite', 'vp', 'director', 'head', 'manager'],
  bd: ['c_suite', 'vp', 'director', 'head'],
  internship: ['vp', 'director', 'head', 'manager', 'senior'],
  recruiting: ['c_suite', 'vp', 'director', 'head', 'manager'],
  sales: ['c_suite', 'vp', 'director', 'head', 'manager'],
};

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { target_id } = (req.body ?? {}) as { target_id?: string };
  if (!target_id) return res.status(400).json({ error: 'missing_target_id' });

  const target = await scope.collection<TargetDoc>('targets').findById(target_id);
  if (!target) return res.status(404).json({ error: 'target_not_found' });
  const mission = await scope.collection<MissionDoc>('missions').findById(target.missionId);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });
  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  const mode = (mission.mode as MissionMode | null) ?? 'sales';
  let domain = normalizeDomain(target.domain);
  if (!domain) {
    domain = await resolveCompanyDomain(target.companyName, mission.targetDescription);
    if (domain) {
      await scope.collection<TargetDoc>('targets').updateById(target._id, { domain });
    }
  }
  const useApollo = apolloEnabled() && !!domain;
  const useSerper = !useApollo && serperEnabled() && !!domain;
  // How the people were discovered (for observability). ContactDoc.source stays
  // 'apollo' | 'web_search' — Serper-discovered people are still web_search.
  const discoverySource = useApollo ? 'apollo' : useSerper ? 'serper' : 'web_search';

  const run = await startRun(scope, {
    agentType: 'contacts',
    missionId: mission._id,
    targetId: target_id,
    input: { source: discoverySource },
  });

  try {
    const discoveryArgs = { target: { ...target, domain }, mission, mode, profile };
    let rows: Array<Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>>;
    if (useApollo) {
      rows = await runApolloHybrid(discoveryArgs);
    } else if (useSerper) {
      rows = await runSerperDiscovery(discoveryArgs);
    } else {
      rows = await runWebSearchOnly(discoveryArgs);
    }

    rows = await resolvePoolWithBudget(rows, domain, target._id);

    if (rows.length === 0) {
      await failRun(scope, run._id, 'no_contacts_found');
      return res.status(502).json({ error: 'no_contacts_found' });
    }

    const inserted = await scope
      .collection<ContactDoc>('contacts')
      .insertMany(rows.map((r) => ({ ...r, _id: newId() })) as InsertDoc<ContactDoc>[]);

    await completeRun(scope, run._id, {
      count: inserted.length,
      source: discoverySource,
    });
    return res.status(200).json({
      run_id: run._id,
      contacts: inserted,
      source: discoverySource,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

async function runWebSearchOnly(args: {
  target: TargetDoc;
  mission: MissionDoc;
  mode: MissionMode;
  profile: ProfileDoc | null;
}): Promise<Array<Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>>> {
  const { target, mission, mode, profile } = args;
  const exclusions = senderContextLines(profile);
  const userPrompt = [
    `Target organization: ${target.companyName}${target.domain ? ` (${target.domain})` : ''}`,
    `Mission mode: ${mode}`,
    `What's being offered: ${mission.goal}`,
    `Why this target: ${target.fitReason ?? mission.targetDescription}`,
    target.whyNow ? `Why now: ${target.whyNow}` : '',
    ...exclusions,
    target.domain
      ? `Company domain for email patterns: ${target.domain}`
      : 'WARNING: no domain on file — use web_search to find the official company website first.',
    '',
    'Find the 2-4 best people to contact at THIS company (not the sender). Use web_search on company site, LinkedIn public pages, press, blog. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const message = await createMessageWithRetry({
    model: MODEL(),
    max_tokens: 2048,
    system: CONTACTS_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = extractJson<{ contacts: ContactSuggestion[] }>(message);
  if (!parsed.ok || !parsed.data?.contacts) throw new Error('parse_failed');

  const filtered = parsed.data.contacts.filter(
    (c) => !isExcludedName(c.name ?? '', senderExclusions(profile))
  );

  // Discovery never produces a trusted email — the LLM's `email` field is
  // ignored and resolution happens later in resolveRowEmails. Keep the pattern
  // only as a display hint.
  return filtered.slice(0, CANDIDATE_POOL_CAP).map((c) => ({
    targetId: target._id,
    missionId: mission._id,
    name: c.name,
    role: c.role,
    email: null,
    emailStatus: 'none' as const,
    linkedinUrl: c.linkedin_url,
    likelyEmailPattern: c.likely_email_pattern,
    confidence: clamp01(c.confidence),
    reasoning: c.reasoning,
    status: 'suggested' as const,
    source: 'web_search' as const,
    apolloPersonId: null,
    seniority: null,
    headline: null,
    location: null,
  }));
}

async function runSerperDiscovery(args: {
  target: TargetDoc;
  mission: MissionDoc;
  mode: MissionMode;
  profile: ProfileDoc | null;
}): Promise<Array<Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>>> {
  const { target, mission, mode, profile } = args;
  const titles = TITLE_HINTS_BY_MODE[mode];

  let results;
  try {
    results = await serperSearchPeople(target.companyName, titles, 10);
  } catch (err) {
    console.error('serper_search_failed', err);
    return runWebSearchOnly(args);
  }
  if (results.length === 0) return runWebSearchOnly(args);

  const exclusions = senderContextLines(profile);
  const userPrompt = [
    `Target organization: ${target.companyName}${target.domain ? ` (${target.domain})` : ''}`,
    `Mission mode: ${mode}`,
    `What's being offered: ${mission.goal}`,
    `Why this target: ${target.fitReason ?? mission.targetDescription}`,
    target.whyNow ? `Why now: ${target.whyNow}` : '',
    ...exclusions,
    '',
    'SEARCH RESULTS (public LinkedIn profiles, via Google):',
    JSON.stringify(
      results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
      null,
      2
    ),
    '',
    'From these results, pick the 2-4 best people to contact at THIS company (not the sender). Extract name, role, and LinkedIn URL from each result. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const message = await createMessageWithRetry({
    model: MODEL(),
    max_tokens: 2048,
    system: CONTACTS_FROM_SERP_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const parsed = extractJson<{ contacts: ContactSuggestion[] }>(message);
  if (!parsed.ok || !parsed.data?.contacts) return runWebSearchOnly(args);

  const filtered = parsed.data.contacts.filter(
    (c) => !isExcludedName(c.name ?? '', senderExclusions(profile))
  );
  if (filtered.length === 0) return runWebSearchOnly(args);

  return filtered.slice(0, CANDIDATE_POOL_CAP).map((c) => ({
    targetId: target._id,
    missionId: mission._id,
    name: c.name,
    role: c.role,
    email: null,
    emailStatus: 'none' as const,
    linkedinUrl: c.linkedin_url,
    likelyEmailPattern: c.likely_email_pattern,
    confidence: clamp01(c.confidence),
    reasoning: c.reasoning,
    status: 'suggested' as const,
    source: 'web_search' as const,
    apolloPersonId: null,
    seniority: null,
    headline: null,
    location: null,
  }));
}

async function runApolloHybrid(args: {
  target: TargetDoc;
  mission: MissionDoc;
  mode: MissionMode;
  profile: ProfileDoc | null;
}): Promise<Array<Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>>> {
  const { target, mission, mode, profile } = args;
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

  if (people.length === 0) return runWebSearchOnly(args);

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
    `${target.companyName} (${target.domain})`,
    target.whyNow ? `Why now: ${target.whyNow}` : '',
    target.fitReason ? `Fit: ${target.fitReason}` : '',
    '',
    `MISSION`,
    `Mode: ${mode}`,
    `Offer: ${mission.goal}`,
    `Audience: ${mission.targetDescription}`,
    '',
    `APOLLO CANDIDATES (${list.length}):`,
    JSON.stringify(list, null, 2),
    '',
    'Pick the 2-4 best fits. Preserve apollo_person_id and email/email_status verbatim. JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const rankMsg = await createMessageWithRetry({
    model: MODEL(),
    max_tokens: 2048,
    system: CONTACTS_RANK_SYSTEM,
    messages: [{ role: 'user', content: rankPrompt }],
  });

  const rankParsed = extractJson<{ contacts: ApolloContactRanked[] }>(rankMsg);
  if (!rankParsed.ok || !rankParsed.data?.contacts) {
    return list.slice(0, CANDIDATE_POOL_CAP).map((p) => ({
      targetId: target._id,
      missionId: mission._id,
      name: p.name,
      role: p.role ?? p.headline ?? 'Unknown',
      email: p.email ?? null,
      emailStatus: p.email_status,
      linkedinUrl: p.linkedin_url ?? null,
      likelyEmailPattern: null,
      confidence: 0.6,
      reasoning: 'Top Apollo match by title and seniority.',
      status: 'suggested' as const,
      source: 'apollo' as const,
      apolloPersonId: p.apollo_person_id ?? null,
      seniority: p.seniority ?? null,
      headline: p.headline ?? null,
      location: p.location ?? null,
    }));
  }

  const byId = new Map(list.map((p) => [p.apollo_person_id ?? '', p]));
  const exclusions = senderExclusions(profile);
  return rankParsed.data.contacts
    .filter((c) => !isExcludedName(c.name ?? '', exclusions))
    .slice(0, CANDIDATE_POOL_CAP)
    .map((c) => {
    const apollo = byId.get(c.apollo_person_id ?? '');
    return {
      targetId: target._id,
      missionId: mission._id,
      name: c.name,
      role: c.role,
      email: apollo?.email ?? c.email ?? null,
      emailStatus: apollo?.email_status ?? c.email_status ?? 'none',
      linkedinUrl: apollo?.linkedin_url ?? c.linkedin_url ?? null,
      likelyEmailPattern: null,
      confidence: clamp01(c.confidence),
      reasoning: c.reasoning,
      status: 'suggested' as const,
      source: 'apollo' as const,
      apolloPersonId: c.apollo_person_id ?? null,
      seniority: apollo?.seniority ?? c.seniority ?? null,
      headline: apollo?.headline ?? c.headline ?? null,
      location: apollo?.location ?? c.location ?? null,
    };
  });
}

type ContactRow = Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>;

// Injectable so the budget walk is unit-testable without network. Defaults wire
// the real company-site scrape and the full resolution cascade.
export interface ResolvePoolDeps {
  scrape: (domain: string) => Promise<ScrapeResult>;
  resolve: (name: string, domain: string, existing: ContactEmailFields, scraped: ScrapeResult) => Promise<ResolvedEmail>;
}

const DEFAULT_RESOLVE_DEPS: ResolvePoolDeps = {
  scrape: scrapeCompanyEmails,
  resolve: (name, domain, existing, scraped) => resolveEmail(name, domain, existing, scraped),
};

// Walk the ranked candidate pool resolving a trustworthy email for each via the
// cascade (emailfinder.dev → verifier gate → real scraped email → none). Keeps a
// row only when it yields a deliverable email ('verified'/'likely'); a 'none'
// candidate is dropped and we try the next one. Stops at TARGET_DELIVERABLE kept
// or RESOLVE_ATTEMPT_CAP attempts (the per-target cost ceiling). Scrapes the
// company site once up front and reuses it. Never ships an unverified guess.
export async function resolvePoolWithBudget(
  rows: ContactRow[],
  domain: string | null,
  targetId: string,
  deps: ResolvePoolDeps = DEFAULT_RESOLVE_DEPS
): Promise<ContactRow[]> {
  if (rows.length === 0) return rows;
  // No domain → can't resolve emails; surface the top-ranked rows display-only.
  if (!domain) {
    return rows.slice(0, TARGET_DELIVERABLE).map((row) => ({ ...row, emailResolver: 'none' as const }));
  }

  let scraped: ScrapeResult;
  try {
    scraped = await deps.scrape(domain);
  } catch (err) {
    console.warn('scrape_company_emails_failed', targetId, err);
    scraped = { domain, emails: [], pattern: null, pagesScraped: [] };
  }

  // Sequential, top-down through the ranked pool. Bounded by both N kept and the
  // attempt cap so a bad domain can't burn the whole pool of finder credits.
  const kept: ContactRow[] = [];
  let attempts = 0;
  for (const row of rows) {
    if (kept.length >= TARGET_DELIVERABLE || attempts >= RESOLVE_ATTEMPT_CAP) break;
    attempts++;
    const resolved = await deps.resolve(
      row.name,
      domain,
      { email: row.email, emailStatus: row.emailStatus, likelyEmailPattern: row.likelyEmailPattern },
      scraped
    );
    if (resolved.email) {
      kept.push({
        ...row,
        email: resolved.email,
        emailStatus: resolved.emailStatus,
        likelyEmailPattern: resolved.likelyEmailPattern,
        emailResolver: resolved.resolver,
      });
    }
  }

  // Empty-pool fallback: nothing came back deliverable → ship the top-ranked
  // rows display-only (email stays null, pattern kept) so a target is never empty.
  if (kept.length === 0) {
    return rows.slice(0, TARGET_DELIVERABLE).map((row) => ({ ...row, emailResolver: 'none' as const }));
  }
  return kept;
}

function clamp01(n: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
