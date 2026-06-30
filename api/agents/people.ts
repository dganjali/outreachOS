// People Discovery agent - "find people" mode. The person-first counterpart to
// the company-first targeting agent (api/agents/target.ts).
//
// Instead of finding companies and (later) the people inside them, this finds
// specific PEOPLE directly, across any company - e.g. "angel investors who back
// dev-tools startups". Each discovered person is inserted as ONE pipeline target
// (status 'suggested') carrying:
//   • the person's CURRENT company as the target's companyName/domain, so the
//     evidence agent still researches the firm and the draft can anchor on it;
//   • a `seedContact` block - the person we found. The contacts agent keys off
//     this to skip fresh discovery and resolve THIS person's email instead.
//
// The pipeline graph is otherwise identical to company mode: the over-discovered
// extra people stay 'suggested' as the replacement "bench" (pipeline.ts reserve).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { MODEL, WEB_SEARCH_TOOL, createMessageWithRetry, extractJson, generateJsonWithSearch } from '../_lib/llm';
import { OPEN_PEOPLE_SEARCH_SYSTEM, OPEN_PEOPLE_FROM_SERP_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { resolveCompanyDomains } from '../_lib/company-enrich';
import { serperEnabled, searchOpenPeoplePool, profileKey, type OpenPeopleQuerySpec, type SerperOrganicResult } from '../_lib/serper';
import { isExcludedName, normalizeDomain, senderContextLines, senderExclusions } from '../_lib/sender-context';
import { getOrCreateContactIcp, narrowIcpBySelection } from './contacts';
import { scoreContact } from '../_lib/seniority';
import type { ContactIcp, ContactTypeFilter, SeniorityLevel } from '../../shared/types';
import type { MissionDoc, ProfileDoc, TargetDoc } from '../../shared/schemas';

interface OpenPerson {
  name: string;
  role: string;
  company: string;
  linkedin_url: string | null;
  location: string | null;
  headline: string | null;
  confidence: number;
  reasoning: string;
}

type TargetRow = Omit<TargetDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { mission_id, count, sectors, functions, seniority } = (req.body ?? {}) as {
    mission_id?: string;
    count?: number;
    sectors?: string[];
    functions?: string[];
    seniority?: SeniorityLevel[];
  };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

  const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });
  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  const desired = Math.min(Math.max(count ?? 10, 1), 25);
  const selectedSectors = sanitizeStrings(sectors);
  const mode = (mission.mode as MissionMode | null) ?? 'sales';

  // WHO to find: the mission's ICP, narrowed by the user's function/seniority
  // picks. Seniority narrows ranking (not the query) so a "find people" search
  // trusts the described audience rather than over-constraining the SERP.
  const baseIcp = await getOrCreateContactIcp(scope, mission, mode);
  const filter: ContactTypeFilter = { functions: functions ?? [], seniority: seniority ?? [] };
  const icp = narrowIcpBySelection(baseIcp, filter);

  // People already discovered for this mission - threaded in so a re-run finds
  // NEW people instead of the same top matches (mirrors target.ts freshness).
  const priorTargets = await scope.collection<TargetDoc>('targets').find({ missionId: mission_id });
  const already = buildAlready(priorTargets);

  const run = await startRun(scope, {
    agentType: 'targeting',
    missionId: mission_id,
    input: { count: desired, mode: 'people', sectors: selectedSectors },
  });

  try {
    const people = await discoverPeople({ icp, profile, mission, sectors: selectedSectors, desired });
    const cleaned = dedupeAndClean(people, profile, already);
    if (cleaned.length === 0) {
      await failRun(scope, run._id, 'no_people_found');
      return res.status(502).json({ error: 'no_people_found' });
    }

    // Resolve each person's current-company domain once, in a batch.
    const domains = await resolveCompanyDomains(
      cleaned.map((p) => ({ name: p.company, hint: mission.targetDescription }))
    );

    // Rank with allowAboveCap: the discovery query already targeted the described
    // audience, so ranking ORDERS the pool, it never hard-drops on seniority (an
    // "angel investor" / GP would otherwise read as above-cap). Disqualifier
    // keywords (former/intern/student) still apply.
    const scored = cleaned.map((p) => ({
      p,
      s: scoreContact({
        title: p.role ?? '',
        headline: p.headline,
        location: p.location,
        llmConfidence: clamp01(p.confidence),
        icp,
        sizeTier: null,
        allowAboveCap: true,
      }),
    }));
    const kept = scored
      .filter((x) => !x.s.disqualified)
      .sort((a, b) => b.s.score - a.s.score)
      .slice(0, desired);
    if (kept.length === 0) {
      await failRun(scope, run._id, 'no_people_kept');
      return res.status(502).json({ error: 'no_people_found' });
    }

    const rows = kept.map(({ p, s }) => toTargetRow(p, s.score, domains, mission_id));
    const inserted = await scope
      .collection<TargetDoc>('targets')
      .insertMany(rows.map((r) => ({ ...r, _id: newId() })) as InsertDoc<TargetDoc>[]);

    await completeRun(scope, run._id, { count: inserted.length, mode: 'people' });
    return res.status(200).json({ run_id: run._id, targets: inserted, source: 'people' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}

// ---------------------------------------------------------------------------
// Discovery: Serper open-people pool → LLM extract; web_search fallback.
// ---------------------------------------------------------------------------

interface DiscoverArgs {
  icp: ContactIcp;
  profile: ProfileDoc | null;
  mission: MissionDoc;
  sectors: string[];
  desired: number;
}

async function discoverPeople(args: DiscoverArgs): Promise<OpenPerson[]> {
  const { icp, sectors } = args;
  if (serperEnabled()) {
    const spec: OpenPeopleQuerySpec = {
      functionKeywords: icp.functionKeywords.length ? icp.functionKeywords : icp.functions,
      sectorTerms: sectors,
      negativeTerms: ['student', 'intern', 'former', 'aspiring'],
      geo: icp.geo.preferred,
    };
    try {
      const pool = await searchOpenPeoplePool(spec, 10);
      if (pool.length > 0) {
        const extracted = await extractPeopleFromResults(pool, args);
        if (extracted.length > 0) return extracted;
      }
    } catch (err) {
      console.error('open_people_serper_failed', err);
    }
  }
  return webSearchPeople(args);
}

function icpLines(icp: ContactIcp): string[] {
  return [
    `Target functions: ${icp.functions.join(', ')}`,
    icp.geo.preferred ? `Location focus: ${icp.geo.preferred}` : '',
  ].filter(Boolean);
}

async function extractPeopleFromResults(results: SerperOrganicResult[], args: DiscoverArgs): Promise<OpenPerson[]> {
  const { mission, icp, profile } = args;
  const userPrompt = [
    `Mission: ${mission.name}`,
    `What's being offered: ${mission.goal}`,
    `Audience / who to find: ${mission.targetDescription}`,
    ...icpLines(icp),
    ...senderContextLines(profile),
    '',
    'SEARCH RESULTS (public LinkedIn profiles, via Google):',
    JSON.stringify(results.map((r) => ({ title: r.title, link: r.link, snippet: r.snippet })), null, 2),
    '',
    'Extract every plausible matching person (up to ~15), each WITH their current company. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  const message = await createMessageWithRetry({
    model: MODEL(),
    max_tokens: 2048,
    system: OPEN_PEOPLE_FROM_SERP_SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const parsed = extractJson<{ people: OpenPerson[] }>(message);
  if (!parsed.ok || !parsed.data?.people) return [];
  return parsed.data.people;
}

async function webSearchPeople(args: DiscoverArgs): Promise<OpenPerson[]> {
  const { mission, icp, profile, sectors, desired } = args;
  const userPrompt = [
    `Mission: ${mission.name}`,
    `What's being offered: ${mission.goal}`,
    `Audience / who to find: ${mission.targetDescription}`,
    sectorBiasLine(sectors),
    ...icpLines(icp),
    ...senderContextLines(profile),
    '',
    `Find ${desired} people who match the audience above. Each MUST include their current company. Use web_search to verify each exists. Output JSON only.`,
  ]
    .filter(Boolean)
    .join('\n');

  const parsed = await generateJsonWithSearch<{ people: OpenPerson[] }>({
    model: MODEL(),
    max_tokens: 4096,
    system: OPEN_PEOPLE_SEARCH_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });
  if (!parsed.ok || !parsed.data?.people) throw new Error('parse_failed');
  return parsed.data.people;
}

// ---------------------------------------------------------------------------
// Clean / dedupe / shape into target rows.
// ---------------------------------------------------------------------------

function dedupeAndClean(people: OpenPerson[], profile: ProfileDoc | null, already: Set<string>): OpenPerson[] {
  const exclusions = senderExclusions(profile);
  const seen = new Set<string>();
  const out: OpenPerson[] = [];
  for (const p of people) {
    const name = (p?.name ?? '').trim();
    const company = (p?.company ?? '').trim();
    if (!name || !company) continue; // company is required downstream
    if (!isLikelyPersonName(name, company)) continue; // a firm/fund slipped in as a "person"
    if (isExcludedName(name, exclusions) || isExcludedName(company, exclusions)) continue;
    const key = personKey({ name, company, linkedin_url: p.linkedin_url });
    if (seen.has(key) || already.has(key)) continue;
    seen.add(key);
    out.push({ ...p, name, company });
  }
  return out;
}

// Tokens that mark a name as an ORGANIZATION, not an individual. For an investor
// audience the search often surfaces fund/firm pages, and the model sometimes
// returns the firm AS the person ("Fin Capital", "VU Venture Partners"). These
// almost never appear in a real human's name in this domain.
const ORG_NAME_RE =
  /\b(ventures?|capital|partners|holdings?|advisors|advisory|management|associates|equity|fund|funds|investor relations|vc|llc|llp|inc|incorporated|ltd|limited|gmbh|technologies|solutions|systems|labs)\b/i;

/** True when `name` plausibly belongs to a PERSON, not a firm/fund. The tells of
 *  a firm slipping in as a person: the name equals the company, it carries a
 *  digit (human names don't), or it reads like an organization. Keeps real names
 *  like "W. David Stern" while dropping "Fin Capital" / "2080 Ventures". */
function isLikelyPersonName(name: string, company: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (/\d/.test(n)) return false; // human names don't carry digits
  if (n.toLowerCase() === company.trim().toLowerCase()) return false; // the firm returned as the person
  if (ORG_NAME_RE.test(n)) return false; // reads like an org, not a person
  return true;
}

/** Stable identity for a discovered person: their LinkedIn profile (preferred)
 *  or name+company. Used to dedupe within a run and to skip people already
 *  surfaced for the mission on a re-run. */
function personKey(p: { name: string; company: string; linkedin_url?: string | null }): string {
  const li = (p.linkedin_url ?? '').trim();
  if (li) return `li:${profileKey(li)}`;
  return `nc:${p.name.trim().toLowerCase()}|${p.company.trim().toLowerCase()}`;
}

function buildAlready(priorTargets: TargetDoc[]): Set<string> {
  const s = new Set<string>();
  for (const t of priorTargets) {
    if (!t.seedContact) continue; // only person-targets count toward freshness
    s.add(personKey({ name: t.seedContact.name, company: t.companyName, linkedin_url: t.seedContact.linkedinUrl }));
  }
  return s;
}

function toTargetRow(p: OpenPerson, score: number, domains: Map<string, string>, missionId: string): TargetRow {
  return {
    missionId,
    companyName: p.company,
    domain: normalizeDomain(domains.get(p.company.trim()) ?? null),
    score: Math.round(clamp01(score) * 100),
    whyNow: null,
    fitReason: p.reasoning ?? null,
    signalType: 'person',
    status: 'suggested',
    source: 'web_search',
    industry: null,
    employeeCount: null,
    headquartersLocation: p.location ?? null,
    seedContact: {
      name: p.name,
      role: p.role ?? null,
      linkedinUrl: p.linkedin_url ?? null,
      location: p.location ?? null,
      headline: p.headline ?? null,
      confidence: clamp01(p.confidence),
    },
  };
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function sanitizeStrings(list?: string[]): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of list) {
    const v = typeof value === 'string' ? value.trim() : '';
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= 10) break;
  }
  return out;
}

function sectorBiasLine(sectors: string[]): string {
  if (sectors.length === 0) return '';
  return `Prefer people who work in these sectors: ${sectors.join(', ')}.`;
}

function clamp01(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// Exported for unit tests.
export { dedupeAndClean, personKey, buildAlready, toTargetRow, isLikelyPersonName };
