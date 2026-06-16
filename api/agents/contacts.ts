import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import {
  createMessageWithRetry,
  MODEL,
  WEB_SEARCH_TOOL,
  extractJson,
  generateJsonWithSearch,
} from '../_lib/llm';
import { CONTACTS_SYSTEM, CONTACTS_FROM_SERP_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { resolveCompanyDomain, enrichCompanySize } from '../_lib/company-enrich';
import { serperEnabled, searchPeoplePool, type PeopleQuerySpec } from '../_lib/serper';
import { resolveEmail, type ContactEmailFields, type ResolvedEmail } from '../_lib/email-resolver';
import { scrapeCompanyEmails, type ScrapeResult } from '../_lib/web-scrape';
import {
  isExcludedName,
  normalizeDomain,
  senderContextLines,
  senderExclusions,
} from '../_lib/sender-context';
import { defaultContactIcp, synthesizeContactIcp } from '../_lib/icp';
import {
  scoreContact,
  sizeTierFromCount,
  effectiveBand,
  rank,
  SENIORITY_RANK,
  type Band,
} from '../_lib/seniority';
import type { ContactIcp, ContactTypeFilter, SeniorityLevel, SizeTier } from '../../shared/types';
import type { ContactDoc, MissionDoc, ProfileDoc, TargetDoc } from '../../shared/schemas';

export interface ContactSuggestion {
  name: string;
  role: string;
  linkedin_url: string | null;
  location: string | null;
  headline: string | null;
  email: string | null;
  likely_email_pattern: string | null;
  confidence: number;
  reasoning: string;
}

// Loop-for-another-contact budget. Discovery hands the resolver a ranked
// candidate pool; the resolver walks it top-down keeping deliverable rows until
// it has TARGET_DELIVERABLE of them or has attempted RESOLVE_ATTEMPT_CAP
// candidates (the per-target cost ceiling - finder/verifier calls cost credits).
const TARGET_DELIVERABLE = 3;
const RESOLVE_ATTEMPT_CAP = 8;
const CANDIDATE_POOL_CAP = 10;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { target_id, contact_type_filter } = (req.body ?? {}) as {
    target_id?: string;
    contact_type_filter?: ContactTypeFilter;
  };
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

  // The adaptive spec of WHO to reach (CONTACT_ENGINE.md §2). Generated once per
  // mission and cached; size tier is resolved per target so the band shifts.
  const baseIcp = await getOrCreateContactIcp(scope, mission, mode);
  // Narrow WHO we look for to the user's selection (if any) before discovery;
  // scoring/ranking already keys off the ICP, so nothing downstream changes.
  const icp = narrowIcpBySelection(baseIcp, contact_type_filter);
  const employeeCount = await getTargetSize(scope, target, domain);
  const sizeTier = sizeTierFromCount(employeeCount);

  const useSerper = serperEnabled() && !!domain;
  const discoverySource = useSerper ? 'serper' : 'web_search';

  const run = await startRun(scope, {
    agentType: 'contacts',
    missionId: mission._id,
    targetId: target_id,
    input: { source: discoverySource },
  });

  try {
    const discoveryArgs: DiscoveryArgs = { target: { ...target, domain }, mission, icp, sizeTier, profile };
    const suggestions = useSerper
      ? await runSerperDiscovery(discoveryArgs)
      : await runWebSearchOnly(discoveryArgs);

    const ranked = rankCandidates(suggestions, { icp, sizeTier, target, mission, profile });

    let rows = ranked.rows;
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
      // Decision-log summary (CONTACT_ENGINE.md §9) - observability for why the
      // pool looked the way it did, without per-contact schema churn.
      sizeTier: sizeTier ?? 'unknown',
      candidates: suggestions.length,
      kept: ranked.rows.length,
      droppedAboveCap: ranked.droppedAboveCap,
      droppedDisqualified: ranked.droppedDisqualified,
      usedAboveCapFallback: ranked.usedFallback,
    });
    return res.status(200).json({
      run_id: run._id,
      contacts: inserted,
      source: discoverySource,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}

// ---------------------------------------------------------------------------
// ICP + size setup
// ---------------------------------------------------------------------------

type Scope = ReturnType<typeof forUser>;

/** Lazily synthesize + cache the mission's ICP; always reflect current geo. */
export async function getOrCreateContactIcp(scope: Scope, mission: MissionDoc, mode: MissionMode): Promise<ContactIcp> {
  const geo = mission.geo ?? null;
  if (mission.contactIcp) {
    return { ...mission.contactIcp, geo: { ...mission.contactIcp.geo, preferred: geo?.trim() || mission.contactIcp.geo.preferred } };
  }
  let icp: ContactIcp;
  try {
    icp = await synthesizeContactIcp({
      mode,
      goal: mission.goal,
      offerDetails: mission.offerDetails,
      targetDescription: mission.targetDescription,
      geo,
    });
  } catch {
    icp = defaultContactIcp(mode, geo);
  }
  try {
    await scope.collection<MissionDoc>('missions').updateById(mission._id, { contactIcp: icp } as Partial<MissionDoc>);
  } catch (err) {
    console.warn('persist_contact_icp_failed', mission._id, err);
  }
  return icp;
}

/**
 * Narrow the ICP to the user's selected contact types. Purely subtractive: we
 * only ever keep functions/levels the ICP already had, never introduce new ones,
 * and never raise `maxLevel` (the size-relative cap in seniority.ts still
 * applies). Any field that would narrow to empty falls back to the full ICP set,
 * so a stray/empty selection can't produce a zero-function or zero-level ICP
 * (which would break query construction and scoring). No selection ⇒ unchanged.
 */
export function narrowIcpBySelection(icp: ContactIcp, filter?: ContactTypeFilter): ContactIcp {
  if (!filter) return icp;

  // Functions: intersect with the user's picks (case-insensitive); empty ⇒ keep all.
  const wantFns = new Set((filter.functions ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean));
  const keptFns = wantFns.size ? icp.functions.filter((f) => wantFns.has(f.toLowerCase())) : icp.functions;
  const functions = keptFns.length ? keptFns : icp.functions;

  // Seniority: keep chosen ideal levels that are valid; empty ⇒ keep the band.
  const wantLevels = (filter.seniority ?? []).filter((l) => l in SENIORITY_RANK);
  const keptLevels = wantLevels.length ? wantLevels : icp.seniority.idealLevels;
  const idealLevels = keptLevels.length ? keptLevels : icp.seniority.idealLevels;

  // Restrict query synonyms to the kept functions when we actually narrowed, so
  // Serper queries don't reintroduce a dropped function. Guard against empty.
  let functionKeywords = icp.functionKeywords;
  if (wantFns.size && functions.length) {
    const narrowed = icp.functionKeywords.filter((kw) =>
      functions.some(
        (f) => f.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(f.toLowerCase())
      )
    );
    if (narrowed.length) functionKeywords = narrowed;
  }

  return {
    ...icp,
    functions,
    functionKeywords,
    seniority: { idealLevels, maxLevel: icp.seniority.maxLevel },
  };
}

/** Resolve + cache the target's headcount so the seniority band can shift. */
async function getTargetSize(scope: Scope, target: TargetDoc, domain: string | null): Promise<number | null> {
  if (typeof target.employeeCount === 'number' && target.employeeCount > 0) return target.employeeCount;
  const n = await enrichCompanySize(target.companyName, domain);
  if (n) {
    try {
      await scope.collection<TargetDoc>('targets').updateById(target._id, { employeeCount: n });
    } catch (err) {
      console.warn('persist_employee_count_failed', target._id, err);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Discovery - produce raw candidate suggestions. Scoring/ranking happens once,
// after, in rankCandidates.
// ---------------------------------------------------------------------------

interface DiscoveryArgs {
  target: TargetDoc;
  mission: MissionDoc;
  icp: ContactIcp;
  sizeTier: SizeTier | null;
  profile: ProfileDoc | null;
}

/** Compact ICP context block injected into the discovery prompts. */
function icpContextLines(icp: ContactIcp, sizeTier: SizeTier | null): string[] {
  const band = effectiveBand(icp, sizeTier);
  return [
    'IDEAL CONTACT PROFILE:',
    `- target functions: ${icp.functions.join(', ')}`,
    `- prefer this seniority band (company is ${sizeTier ?? 'unknown'} size): ${bandLabel(band)}`,
    `- who replies: ${icp.rationale}`,
    icp.geo.preferred ? `- location focus: ${icp.geo.preferred}` : '',
  ].filter(Boolean);
}

function bandLabel(band: Band): string {
  const name = (r: number) =>
    (Object.entries(SENIORITY_RANK).find(([, v]) => v === r)?.[0] ?? `rank${r}`).replace(/_/g, ' ');
  return `${name(band.idealMin)} → ${name(band.idealMax)} (never above ${name(band.hardMax)})`;
}

async function runWebSearchOnly(args: DiscoveryArgs): Promise<ContactSuggestion[]> {
  const { target, mission, icp, sizeTier } = args;
  const userPrompt = [
    `Target organization: ${target.companyName}${target.domain ? ` (${target.domain})` : ''}`,
    `Mission mode: ${mission.mode}`,
    `What's being offered: ${mission.goal}`,
    `Why this target: ${target.fitReason ?? mission.targetDescription}`,
    target.whyNow ? `Why now: ${target.whyNow}` : '',
    ...senderContextLines(args.profile),
    ...icpContextLines(icp, sizeTier),
    target.domain
      ? `Company domain for email patterns: ${target.domain}`
      : 'WARNING: no domain on file - use web_search to find the official company website first.',
    '',
    'Find 3-6 people matching the ICP function at THIS company (not the sender). Favor the program owners (managers/directors) over execs. Use web_search on company site, LinkedIn public pages, press, blog. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const parsed = await generateJsonWithSearch<{ contacts: ContactSuggestion[] }>({
    model: MODEL(),
    max_tokens: 2048,
    system: CONTACTS_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });
  if (!parsed.ok || !parsed.data?.contacts) throw new Error('parse_failed');
  return parsed.data.contacts;
}

async function runSerperDiscovery(args: DiscoveryArgs): Promise<ContactSuggestion[]> {
  const { target, mission, icp, sizeTier } = args;
  const spec: PeopleQuerySpec = {
    companyName: target.companyName,
    functionKeywords: icp.functionKeywords.length ? icp.functionKeywords : icp.functions,
    seniorityKeywords: seniorityQueryKeywords(icp),
    negativeTerms: negativeTermsForQuery(effectiveBand(icp, sizeTier)),
    geo: icp.geo.preferred,
  };

  let results;
  try {
    results = await searchPeoplePool(spec, 8);
  } catch (err) {
    console.error('serper_search_failed', err);
    return runWebSearchOnly(args);
  }
  if (results.length === 0) return runWebSearchOnly(args);

  const userPrompt = [
    `Target organization: ${target.companyName}${target.domain ? ` (${target.domain})` : ''}`,
    `Mission mode: ${mission.mode}`,
    `What's being offered: ${mission.goal}`,
    `Why this target: ${target.fitReason ?? mission.targetDescription}`,
    target.whyNow ? `Why now: ${target.whyNow}` : '',
    ...senderContextLines(args.profile),
    ...icpContextLines(icp, sizeTier),
    '',
    'SEARCH RESULTS (public LinkedIn profiles, via Google):',
    JSON.stringify(
      results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })),
      null,
      2
    ),
    '',
    'From these results, extract every plausible on-function person (4-8 is fine). Capture each title verbatim plus location/headline when shown. Output JSON only.',
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
  if (parsed.data.contacts.length === 0) return runWebSearchOnly(args);
  return parsed.data.contacts;
}

// Map the ICP's ideal levels to LinkedIn-friendly query words.
const LEVEL_QUERY_WORDS: Record<SeniorityLevel, string[]> = {
  ic: ['specialist', 'associate'],
  senior_ic: ['senior', 'principal'],
  lead: ['lead'],
  manager: ['manager'],
  senior_manager: ['senior manager', 'manager'],
  director: ['director', 'head'],
  senior_director: ['director'],
  vp: ['vice president'],
  svp: ['vice president'],
  cxo: ['chief'],
  founder: ['founder'],
};

function seniorityQueryKeywords(icp: ContactIcp): string[] {
  const out = new Set<string>();
  for (const lvl of icp.seniority.idealLevels) {
    for (const w of LEVEL_QUERY_WORDS[lvl] ?? []) out.add(w);
  }
  return [...out];
}

/** Exec terms to negative-filter when the band caps below them. */
function negativeTermsForQuery(band: Band): string[] {
  const negs: string[] = [];
  if (band.hardMax < rank('founder')) negs.push('president', 'founder', 'owner');
  if (band.hardMax < rank('cxo')) negs.push('chief', 'ceo', 'cmo', 'cfo', 'cto', 'coo');
  if (band.hardMax < rank('svp')) negs.push('svp');
  if (band.hardMax < rank('vp')) negs.push('vp');
  return negs;
}

// ---------------------------------------------------------------------------
// Ranking - score every candidate, drop the misses, sort by reply-likelihood.
// ---------------------------------------------------------------------------

type ContactRow = Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>;

interface RankResult {
  rows: ContactRow[];
  droppedAboveCap: number;
  droppedDisqualified: number;
  usedFallback: boolean;
}

export function rankCandidates(
  suggestions: ContactSuggestion[],
  ctx: { icp: ContactIcp; sizeTier: SizeTier | null; target: TargetDoc; mission: MissionDoc; profile: ProfileDoc | null }
): RankResult {
  const { icp, sizeTier, target, mission, profile } = ctx;
  const exclusions = senderExclusions(profile);
  const cleaned = suggestions.filter((c) => c?.name && !isExcludedName(c.name, exclusions));

  const score = (c: ContactSuggestion, allowAboveCap: boolean) =>
    scoreContact({
      title: c.role ?? '',
      headline: c.headline,
      location: c.location,
      llmConfidence: clamp01(c.confidence),
      icp,
      sizeTier,
      allowAboveCap,
    });

  const scored = cleaned.map((c) => ({ c, s: score(c, false) }));
  let kept = scored.filter((x) => !x.s.disqualified);
  let usedFallback = false;

  // Never return an empty target. If the band dropped everyone, re-score with
  // allowAboveCap so the best-available people surface (flagged in the log).
  if (kept.length === 0 && cleaned.length > 0) {
    usedFallback = true;
    kept = cleaned.map((c) => ({ c, s: score(c, true) })).filter((x) => !x.s.disqualified);
  }

  kept.sort((a, b) => b.s.score - a.s.score);

  const droppedDisqualified = scored.filter(
    (x) => x.s.disqualified && x.s.reasons.some((r) => r.startsWith('disqualified'))
  ).length;
  const droppedAboveCap = scored.filter(
    (x) => x.s.disqualified && x.s.reasons.some((r) => r.startsWith('above cap'))
  ).length;

  const rows = kept.slice(0, CANDIDATE_POOL_CAP).map(({ c, s }) => ({
    targetId: target._id,
    missionId: mission._id,
    name: c.name,
    role: c.role,
    email: null,
    emailStatus: 'none' as const,
    linkedinUrl: c.linkedin_url ?? null,
    likelyEmailPattern: c.likely_email_pattern ?? null,
    // confidence now carries the composite reply-likelihood score so downstream
    // ranking (pipeline "best" pick) selects the most reply-likely contact.
    confidence: s.score,
    reasoning: c.reasoning ?? null,
    status: 'suggested' as const,
    source: 'web_search' as const,
    seniority: s.level,
    headline: c.headline ?? null,
    location: c.location ?? null,
  }));

  return { rows, droppedAboveCap, droppedDisqualified, usedFallback };
}

// ---------------------------------------------------------------------------
// Email resolution (unchanged) - walk the ranked pool keeping deliverable rows.
// ---------------------------------------------------------------------------

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

  // Top-down through the ranked pool, but resolve each batch CONCURRENTLY instead
  // of one candidate at a time (the per-candidate finder→verifier round-trips were
  // the dominant per-target latency). Each batch is sized to exactly how many more
  // deliverables we still need (capped by the remaining attempt budget), so the
  // fan-out never resolves more candidates than the sequential walk would have -
  // same finder/verifier spend, just parallelized. Bounded by both N kept and the
  // attempt cap so a bad domain can't burn the whole pool of finder credits.
  const kept: ContactRow[] = [];
  let attempts = 0;
  let i = 0;
  while (i < rows.length && kept.length < TARGET_DELIVERABLE && attempts < RESOLVE_ATTEMPT_CAP) {
    const need = TARGET_DELIVERABLE - kept.length;
    const budget = RESOLVE_ATTEMPT_CAP - attempts;
    const batch = rows.slice(i, i + Math.min(need, budget));
    i += batch.length;
    attempts += batch.length;

    const resolved = await Promise.all(
      batch.map((row) =>
        deps.resolve(
          row.name,
          domain,
          { email: row.email, emailStatus: row.emailStatus, likelyEmailPattern: row.likelyEmailPattern },
          scraped
        )
      )
    );

    // Keep deliverable rows in their ranked (batch) order; never exceed the cap.
    batch.forEach((row, j) => {
      const res = resolved[j];
      if (res.email && kept.length < TARGET_DELIVERABLE) {
        kept.push({
          ...row,
          email: res.email,
          emailStatus: res.emailStatus,
          likelyEmailPattern: res.likelyEmailPattern,
          emailResolver: res.resolver,
        });
      }
    });
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
