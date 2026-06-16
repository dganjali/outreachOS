// Targeting agent - finds organizations to outreach.
// Mongo + Express edition.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { MODEL, WEB_SEARCH_TOOL, generateJsonWithSearch } from '../_lib/llm';
import { TARGETING_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { resolveCompanyDomains } from '../_lib/company-enrich';
import {
  isExcludedName,
  isValidDomain,
  normalizeDomain,
  senderContextLines,
  senderExclusions,
} from '../_lib/sender-context';
import type { MissionDoc, ProfileDoc, TargetDoc } from '../../shared/schemas';

interface TargetSuggestion {
  company_name: string;
  domain: string | null;
  score: number;
  why_now: string;
  fit_reason: string;
  signal_type: string;
}

// Companies already surfaced for a mission - used to keep re-runs fresh.
interface AlreadyTargeted {
  names: string[];
  domains: Set<string>;
}

const EXCLUDE_PROMPT_CAP = 60;

// Prompt line telling the model which companies are already covered, so it
// spends its picks on new ones. Empty string (filtered out) on a first run.
function alreadyTargetedLine(prior: AlreadyTargeted): string {
  if (prior.names.length === 0) return '';
  const list = prior.names.slice(0, EXCLUDE_PROMPT_CAP).join(', ');
  return `Already covered in this mission - DO NOT include these; find different companies: ${list}`;
}

function sanitizeSectors(list?: string[]): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of list) {
    const sector = typeof value === 'string' ? value.trim() : '';
    const key = sector.toLowerCase();
    if (!sector || seen.has(key)) continue;
    seen.add(key);
    out.push(sector);
    if (out.length >= 10) break;
  }
  return out;
}

function sectorBiasLine(sectors: string[]): string {
  if (sectors.length === 0) return '';
  return [
    `Strong sector preference: prioritize companies in these sectors: ${sectors.join(', ')}.`,
    'Treat this as a strong targeting bias: most results should clearly fit one of these sectors unless a company is an exceptional match for the mission.',
  ].join(' ');
}

// True if a candidate matches a company already surfaced for the mission, by
// normalized domain (preferred) or name.
function isAlreadyTargeted(name: string, domain: string | null, prior: AlreadyTargeted): boolean {
  const d = normalizeDomain(domain);
  if (d && prior.domains.has(d)) return true;
  return isExcludedName(name, prior.names.map((n) => n.toLowerCase()));
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { mission_id, count, sectors } = (req.body ?? {}) as { mission_id?: string; count?: number; sectors?: string[] };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

  const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  const desired = Math.min(Math.max(count ?? 10, 1), 25);
  const selectedSectors = sanitizeSectors(sectors);

  // Companies already surfaced for this mission. Threaded into the prompts (so
  // the model picks different ones) and used to drop any that slip through, so a
  // re-run of the same mission finds NEW companies instead of the same top picks.
  const priorTargets = await scope.collection<TargetDoc>('targets').find({ missionId: mission_id });
  const alreadyTargeted: AlreadyTargeted = {
    names: priorTargets.map((t) => (t.companyName ?? '').trim()).filter(Boolean),
    domains: new Set(
      priorTargets.map((t) => normalizeDomain(t.domain)).filter((d): d is string => !!d)
    ),
  };

  const run = await startRun(scope, {
    agentType: 'targeting',
    missionId: mission_id,
    input: { count: desired, source: 'web_search', sectors: selectedSectors },
  });

  const mode = (mission.mode as MissionMode | null) ?? 'sales';

  try {
    const rows = await runWebSearchOnly({ mission, mode, desired, profile, mission_id, alreadyTargeted, sectors: selectedSectors });

    if (rows.length === 0) {
      await failRun(scope, run._id, 'no_targets_found');
      return res.status(502).json({ error: 'no_targets_found' });
    }

    const inserted = await scope
      .collection<TargetDoc>('targets')
      .insertMany(rows.map((r) => ({ ...r, _id: newId() })) as InsertDoc<TargetDoc>[]);

    await completeRun(scope, run._id, {
      count: inserted.length,
      source: 'web_search',
    });
    return res.status(200).json({
      run_id: run._id,
      targets: inserted,
      source: 'web_search',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}

async function runWebSearchOnly(args: {
  mission: MissionDoc;
  mode: MissionMode;
  desired: number;
  profile: ProfileDoc | null;
  mission_id: string;
  alreadyTargeted: AlreadyTargeted;
  sectors: string[];
}): Promise<Array<Omit<TargetDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>>> {
  const { mission, mode, desired, profile, mission_id, alreadyTargeted, sectors } = args;
  const userPrompt = [
    `Mission: ${mission.name}`,
    `Mode: ${mode}`,
    `What I'm sending / offer: ${mission.goal}`,
    `Target description (the why): ${mission.targetDescription}`,
    sectorBiasLine(sectors),
    ...senderContextLines(profile),
    alreadyTargetedLine(alreadyTargeted),
    '',
    `Find ${desired} target organizations with strong recent "why now" signals.`,
    'Each MUST have a verified website domain. Use web_search to confirm the company exists and matches the audience/geography above.',
    'Return JSON only, no commentary.',
  ]
    .filter(Boolean)
    .join('\n');

  const parsed = await generateJsonWithSearch<{ targets: TargetSuggestion[] }>({
    model: MODEL(),
    max_tokens: 4096,
    system: TARGETING_SYSTEM,
    tools: [WEB_SEARCH_TOOL],
    messages: [{ role: 'user', content: userPrompt }],
  });
  if (!parsed.ok || !parsed.data?.targets) throw new Error('parse_failed');

  const exclusions = senderExclusions(profile);
  let candidates = parsed.data.targets.filter((t) => {
    const name = (t.company_name ?? '').trim();
    return !!name && !isExcludedName(name, exclusions);
  });

  const missingDomain = candidates.filter((t) => !isValidDomain(normalizeDomain(t.domain)));
  if (missingDomain.length > 0) {
    const resolved = await resolveCompanyDomains(
      missingDomain.map((t) => ({ name: t.company_name, hint: mission.targetDescription }))
    );
    candidates = candidates.map((t) => ({
      ...t,
      domain: normalizeDomain(t.domain) ?? resolved.get(t.company_name.trim()) ?? t.domain,
    }));
  }

  const filtered = candidates.filter(
    (t) =>
      isValidDomain(normalizeDomain(t.domain)) &&
      !isAlreadyTargeted(t.company_name, t.domain, alreadyTargeted)
  );

  return filtered.slice(0, desired).map((t) => ({
    missionId: mission_id,
    companyName: t.company_name,
    domain: normalizeDomain(t.domain),
    score: clamp(t.score, 0, 100),
    whyNow: t.why_now,
    fitReason: t.fit_reason,
    signalType: t.signal_type,
    status: 'suggested' as const,
    source: 'web_search' as const,
    industry: null,
    employeeCount: null,
    headquartersLocation: null,
  }));
}

function clamp(n: number, lo: number, hi: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
