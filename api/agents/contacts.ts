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
import { verifyContactFit, verdictAccepted, type ContactVerification } from '../_lib/contact-verify';
import { env } from '../_lib/env';
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
// it has the requested number of them or has attempted RESOLVE_ATTEMPT_CAP
// candidates (the per-target cost ceiling - finder/verifier calls cost credits).
const DEFAULT_DELIVERABLE = 1;
const MAX_CONTACTS_PER_TARGET = 5;
// Per-target email-resolution attempt ceiling. emailfinder MISSES are free
// (charged only on a hit) and the verifier only runs on a hit, so a higher cap
// buys more coverage at near-zero cost - it just lets the resolver walk deeper
// into the ranked pool when the top candidates don't resolve.
const RESOLVE_ATTEMPT_CAP = 15;
// Max candidates kept after ranking. Raised in step with the attempt cap so the
// larger discovered pool isn't truncated before the resolver ever sees it.
const CANDIDATE_POOL_CAP = 20;
// Concurrency for the resolve walk. Deliberately NOT raised with the cap: this
// is the only knob that spends paid verifier calls speculatively (on the
// "keep 1" hot path it resolves up to LOOKAHEAD at once), so keeping it small
// bounds wasted spend while the higher cap above adds only free finder misses.
const RESOLVE_LOOKAHEAD = 3;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { target_id, contact_type_filter, top_contacts } = (req.body ?? {}) as {
    target_id?: string;
    contact_type_filter?: ContactTypeFilter;
    top_contacts?: number;
  };
  if (!target_id) return res.status(400).json({ error: 'missing_target_id' });
  // How many deliverable contacts to keep for this company. Caller-supplied
  // (the pipeline forwards the run's `topContacts`; the manual button its own
  // count); defaults to 1 and is clamped to the per-target ceiling.
  const wanted = Math.min(Math.max(Math.trunc(Number(top_contacts)) || 1, 1), MAX_CONTACTS_PER_TARGET);

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

  // People mode: this target was discovered FOR a specific person (target.ts'
  // counterpart agent seeds it). Skip fresh discovery entirely and resolve THIS
  // person's email - everything downstream (rank, resolve, fill) is unchanged.
  const seeded = target.seedContact ?? null;
  const useSerper = serperEnabled() && !!domain;
  const discoverySource = seeded ? 'seed' : useSerper ? 'serper' : 'web_search';

  const run = await startRun(scope, {
    agentType: 'contacts',
    missionId: mission._id,
    targetId: target_id,
    input: { source: discoverySource },
  });

  try {
    const discoveryArgs: DiscoveryArgs = { target: { ...target, domain }, mission, icp, sizeTier, profile };
    const suggestions = seeded
      ? [seedToSuggestion(seeded)]
      : useSerper
        ? await runSerperDiscovery(discoveryArgs)
        : await runWebSearchOnly(discoveryArgs);

    const ranked = rankCandidates(suggestions, { icp, sizeTier, target, mission, profile });

    // The recipient-verification gate: research each reachable candidate and drop
    // the ones who don't actually fit the mission (wrong person, former
    // affiliation, wrong team). Runs inside the resolve walk so it only spends a
    // web_search on people we could actually email, and a dropped mismatch makes
    // the walk pull the next candidate - exactly like an unreachable email.
    const verify = env.CONTACT_VERIFY_ENABLED()
      ? (row: ContactRow): Promise<ContactVerification> =>
          verifyContactFit({
            person: {
              name: row.name,
              role: row.role,
              headline: row.headline,
              linkedinUrl: row.linkedinUrl,
              location: row.location,
            },
            company: target.companyName,
            domain,
            mission: {
              mode,
              goal: mission.goal,
              offerDetails: mission.offerDetails,
              targetDescription: mission.targetDescription,
            },
            icp,
          })
      : undefined;

    const resolved = await resolvePoolWithBudget(ranked.rows, domain, target._id, wanted, {
      ...DEFAULT_RESOLVE_DEPS,
      verify,
    });

    // Start with the deliverable (verified/likely email) rows, then - if we still
    // haven't reached `wanted` - top up with the best email-less people discovery
    // surfaced. A company where we found the right person but couldn't VERIFY an
    // address is far more useful shown (with their LinkedIn / likely pattern) than
    // dropped: the user can still reach them. Only a company where discovery found
    // nobody at all comes back empty.
    //
    // EXCEPTION: when the recipient-verification gate is active we deliberately do
    // NOT surface display-only people. Those candidates were never verified (the
    // gate only runs on reachable ones), and the whole point of the gate is that
    // we only ever put VERIFIED people in front of the user. An unverified,
    // unreachable contact is exactly the noise this feature exists to remove; the
    // pipeline's replacement loop backfills the count from the bench instead.
    const rows = verify ? resolved.rows : fillWithDisplayOnly(resolved.rows, ranked.rows, wanted);

    if (rows.length === 0) {
      // Categorize WHERE the company was lost so a "No contacts" drop is
      // self-explanatory in agent_runs - the dominant stage drives the next
      // round of tuning (more discovery vs. better domains vs. finder coverage).
      const dropStage = !domain
        ? 'no_domain'
        : suggestions.length === 0
          ? 'no_candidates'
          : ranked.rows.length === 0
            ? 'no_candidates_kept'
            : // Everyone reachable failed verification ⇒ the candidates existed but
              // none actually fit the mission (the "wrong people" case this gate
              // is for). Distinct from "couldn't find an email" so tuning is clear.
              resolved.verifiedDropped > 0 && resolved.rows.length === 0
              ? 'all_unverified'
              : 'no_email_resolved';
      await failRun(scope, run._id, 'no_contacts_found', {
        dropStage,
        source: discoverySource,
        domainResolved: !!domain,
        sizeTier: sizeTier ?? 'unknown',
        candidates: suggestions.length,
        kept: ranked.rows.length,
        droppedAboveCap: ranked.droppedAboveCap,
        droppedDisqualified: ranked.droppedDisqualified,
        usedAboveCapFallback: ranked.usedFallback,
        attempts: resolved.attempts,
        resolverCounts: resolved.resolverCounts,
        verifiedDropped: resolved.verifiedDropped,
      });
      return res.status(502).json({ error: 'no_contacts_found' });
    }

    const inserted = await scope
      .collection<ContactDoc>('contacts')
      .insertMany(rows.map((r) => ({ ...r, _id: newId() })) as InsertDoc<ContactDoc>[]);

    const withEmail = rows.filter((r) => !!r.email).length;
    await completeRun(scope, run._id, {
      count: inserted.length,
      // Split the deliverable rows from the display-only (no verified email) ones
      // so the decision log shows when a company was surfaced on people alone.
      withEmail,
      displayOnly: inserted.length - withEmail,
      source: discoverySource,
      // Decision-log summary (CONTACT_ENGINE.md §9) - observability for why the
      // pool looked the way it did, without per-contact schema churn.
      sizeTier: sizeTier ?? 'unknown',
      candidates: suggestions.length,
      kept: ranked.rows.length,
      droppedAboveCap: ranked.droppedAboveCap,
      droppedDisqualified: ranked.droppedDisqualified,
      usedAboveCapFallback: ranked.usedFallback,
      attempts: resolved.attempts,
      resolverCounts: resolved.resolverCounts,
      // How many reachable people the recipient-verification gate dropped as a
      // clear mismatch. A high count means discovery is finding wrong-fit people.
      verifiedDropped: resolved.verifiedDropped,
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

/** People mode: turn the target's seeded person into the single discovery
 *  candidate, so ranking + email resolution run on them as if just discovered. */
export function seedToSuggestion(seed: NonNullable<TargetDoc['seedContact']>): ContactSuggestion {
  return {
    name: seed.name,
    role: seed.role ?? '',
    linkedin_url: seed.linkedinUrl ?? null,
    location: seed.location ?? null,
    headline: seed.headline ?? null,
    email: null,
    likely_email_pattern: null,
    confidence: typeof seed.confidence === 'number' ? seed.confidence : 0.7,
    reasoning: 'Matched directly in people search',
  };
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
    'Find 6-10 people matching the ICP function at THIS company (not the sender). Favor the program owners (managers/directors) over execs. Use web_search on company site, LinkedIn public pages, press, blog. Output JSON only.',
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
    results = await searchPeoplePool(spec, 10);
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
    'From these results, extract every plausible on-function person that appears (up to ~15 - more candidates give the resolver more chances to land a verified email). Capture each title verbatim plus location/headline when shown. Output JSON only.',
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

/**
 * Combine the resolved (deliverable-email) rows with the best remaining ranked
 * people so a company that yielded real candidates is never returned empty just
 * because no address could be VERIFIED. Verified/likely-email rows always rank
 * first (they came from `resolved`); display-only rows - LinkedIn link / likely
 * pattern, `emailStatus: 'none'` - backfill in rank order up to `wanted`.
 * Dedupes on linkedinUrl|name so a resolved row and its source candidate can't
 * both appear.
 */
export function fillWithDisplayOnly(
  resolved: ContactRow[],
  ranked: ContactRow[],
  wanted: number
): ContactRow[] {
  const out = [...resolved];
  if (out.length >= wanted) return out;
  const seen = new Set(out.map(contactKey));
  for (const row of ranked) {
    if (out.length >= wanted) break;
    const key = contactKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function contactKey(r: ContactRow): string {
  return `${(r.linkedinUrl ?? '').trim().toLowerCase()}|${r.name.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Email resolution (unchanged) - walk the ranked pool keeping deliverable rows.
// ---------------------------------------------------------------------------

// Injectable so the budget walk is unit-testable without network. Defaults wire
// the real company-site scrape and the full resolution cascade.
export interface ResolvePoolDeps {
  scrape: (domain: string) => Promise<ScrapeResult>;
  resolve: (name: string, domain: string, existing: ContactEmailFields, scraped: ScrapeResult) => Promise<ResolvedEmail>;
  /** Recipient-verification gate. Optional: when omitted (unit tests, or the
   *  feature flag off) the walk keeps every deliverable row exactly as before.
   *  When present it runs ONLY on candidates that resolved an email, and a
   *  'mismatch' verdict drops the row so the walk pulls the next candidate. */
  verify?: (row: ContactRow) => Promise<ContactVerification>;
}

const DEFAULT_RESOLVE_DEPS: ResolvePoolDeps = {
  scrape: scrapeCompanyEmails,
  resolve: (name, domain, existing, scraped) => resolveEmail(name, domain, existing, scraped),
};

// Which cascade rung produced each attempt's result. Tallied across the walk so
// a drop is debuggable: all-`none` means the finder/scrape found nobody, while a
// pool that ran out before `want` (attempts == pool size < cap) means discovery
// was too thin. Surfaced via run telemetry (see the contacts handler).
type ResolverName = ResolvedEmail['resolver'];

export interface ResolvePoolResult {
  rows: ContactRow[];
  attempts: number;
  resolverCounts: Record<ResolverName, number>;
  // How many reachable candidates the verification gate dropped as a clear
  // mismatch. 0 when the gate is off. Surfaced via run telemetry so a company
  // lost to "all wrong people" is distinguishable from "no email found".
  verifiedDropped: number;
}

function emptyResolverCounts(): Record<ResolverName, number> {
  return { preexisting: 0, email_finder: 0, scrape: 0, verifier: 0, none: 0 };
}

// Walk the ranked candidate pool resolving a trustworthy email for each via the
// cascade (emailfinder.dev → verifier gate → real scraped email → none). Keeps a
// row only when it yields a deliverable email ('verified'/'likely'); a 'none'
// candidate is dropped and we try the next one. Stops at `count` kept
// or RESOLVE_ATTEMPT_CAP attempts (the per-target cost ceiling). Scrapes the
// company site once up front and reuses it. Never ships an unverified guess.
export async function resolvePoolWithBudget(
  rows: ContactRow[],
  domain: string | null,
  targetId: string,
  count: number = DEFAULT_DELIVERABLE,
  deps: ResolvePoolDeps = DEFAULT_RESOLVE_DEPS
): Promise<ResolvePoolResult> {
  const want = Math.max(1, count);
  const resolverCounts = emptyResolverCounts();
  let verifiedDropped = 0;
  if (rows.length === 0) return { rows, attempts: 0, resolverCounts, verifiedDropped };
  // No domain → can't resolve emails, so we can't ship a deliverable contact.
  // Return empty so the caller drops/replaces this company (no email guesses).
  if (!domain) return { rows: [], attempts: 0, resolverCounts, verifiedDropped };

  let scraped: ScrapeResult;
  try {
    scraped = await deps.scrape(domain);
  } catch (err) {
    console.warn('scrape_company_emails_failed', targetId, err);
    scraped = { domain, emails: [], pattern: null, pagesScraped: [] };
  }

  // Top-down through the ranked pool, resolving a small lookahead batch
  // CONCURRENTLY instead of one candidate at a time. For the common "keep 1"
  // case this may spend a couple of extra finder/verifier attempts when the top
  // result would have worked, but it removes the worst latency cliff: waiting
  // through several serial misses at one company.
  const kept: ContactRow[] = [];
  let attempts = 0;
  let i = 0;
  while (i < rows.length && kept.length < want && attempts < RESOLVE_ATTEMPT_CAP) {
    const need = want - kept.length;
    const budget = RESOLVE_ATTEMPT_CAP - attempts;
    const batchSize = Math.min(Math.max(need, RESOLVE_LOOKAHEAD), budget);
    const batch = rows.slice(i, i + batchSize);
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

    // Verify ONLY the candidates that resolved a deliverable email - we never
    // spend a verification on someone we can't reach. Runs concurrently within
    // the batch (it is the slow, paid step); a null entry means "not verified"
    // (no gate, or no email to gate).
    const verifications = await Promise.all(
      batch.map((row, j) =>
        deps.verify && resolved[j].email ? deps.verify(row) : Promise.resolve(null)
      )
    );

    // Keep deliverable rows in their ranked (batch) order; never exceed the cap.
    // A reachable candidate the gate marks a clear mismatch is dropped (and the
    // walk continues to the next), exactly like an unreachable one.
    for (let j = 0; j < batch.length; j++) {
      const res = resolved[j];
      resolverCounts[res.resolver] += 1; // telemetry: where each attempt landed
      if (!res.email) continue;
      const verification = verifications[j];
      if (verification && !verdictAccepted(verification)) {
        verifiedDropped += 1;
        continue;
      }
      if (kept.length >= want) continue;
      kept.push({
        ...batch[j],
        email: res.email,
        emailStatus: res.emailStatus,
        likelyEmailPattern: res.likelyEmailPattern,
        emailResolver: res.resolver,
        ...(verification
          ? {
              verification: {
                verdict: verification.verdict,
                confidence: verification.confidence,
                reason: verification.reason,
                checkedAt: new Date(),
              },
              personResearch: verification.research.length ? verification.research : null,
            }
          : {}),
      });
    }
  }

  // `kept` empty → caller drops/replaces this company (we never ship display-only
  // rows with no verified email). `attempts`/`resolverCounts`/`verifiedDropped`
  // ride along so the run telemetry can show WHY it came back empty.
  return { rows: kept, attempts, resolverCounts, verifiedDropped };
}

function clamp01(n: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
