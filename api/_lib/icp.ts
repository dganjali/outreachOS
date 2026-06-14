// Ideal Contact Profile (ICP-People) — the adaptive spec of WHO to reach at a
// target (CONTACT_ENGINE.md §2/§7/§8).
//
// Two layers:
//   • MODE_ICP_PRIOR — the deterministic "who actually replies" model per mode.
//     This is the seniority philosophy (owner/manager band, capped) we never let
//     the LLM drift away from.
//   • synthesizeContactIcp — one LLM call per mission that ADAPTS the function
//     set + geo to the specific offer/audience, seeded by the prior. Seniority
//     stays from the prior (the LLM is bad at the band philosophy and would
//     re-introduce exec bias); per-target size shifting happens later in
//     seniority.ts.

import type { ContactIcp, MissionMode } from '../../shared/types';
import { generateJson, MODEL } from './llm';
import { CONTACT_ICP_SYSTEM } from './prompts';

type Prior = Pick<ContactIcp, 'functions' | 'functionKeywords' | 'seniority' | 'disqualifierKeywords' | 'routerOk' | 'rationale'>;

// Non-seniority hard excludes shared by most modes. Seniority is handled by the
// size-relative band, NOT by keywords, so these stay size-independent.
const COMMON_DISQUALIFIERS = ['former', 'retired', 'intern', 'student', 'seeking', 'open to work'];

export const MODE_ICP_PRIOR: Record<MissionMode, Prior> = {
  sponsorship: {
    functions: ['community', 'developer relations', 'developer marketing', 'brand partnerships', 'sponsorships', 'events', 'ecosystem', 'community investment', 'partnerships'],
    functionKeywords: ['community', 'devrel', 'developer relations', 'sponsorship', 'events', 'ecosystem', 'brand', 'partnerships'],
    seniority: { idealLevels: ['manager', 'senior_manager', 'director'], maxLevel: 'director' },
    disqualifierKeywords: COMMON_DISQUALIFIERS,
    routerOk: true, // event/community leads happily route to the budget owner
    rationale: 'Community / DevRel / sponsorship managers & directors own the program and budget conversation and reply to cold outreach; CMOs and presidents delegate it.',
  },
  bd: {
    functions: ['business development', 'partnerships', 'alliances', 'strategic partnerships', 'ecosystem', 'corporate development', 'integrations'],
    functionKeywords: ['business development', 'partnerships', 'alliances', 'ecosystem', 'integrations'],
    seniority: { idealLevels: ['manager', 'senior_manager', 'director'], maxLevel: 'director' },
    disqualifierKeywords: COMMON_DISQUALIFIERS,
    routerOk: false,
    rationale: 'Partnerships/BD managers & directors take intro meetings and champion deals internally; a Chief Partnership Officer at scale will not reply to a cold email.',
  },
  internship: {
    functions: ['engineering', 'recruiting', 'talent', 'university recruiting', 'early career', 'hiring'],
    functionKeywords: ['engineering', 'recruiting', 'talent', 'university', 'early career', 'hiring manager'],
    seniority: { idealLevels: ['senior_ic', 'lead', 'manager'], maxLevel: 'director' },
    disqualifierKeywords: ['former', 'retired'],
    routerOk: true, // recruiters route to the hiring manager
    rationale: 'Hiring managers, team leads, recruiters, and ICs on the team (for a warm intro) respond; VPs and execs do not.',
  },
  recruiting: {
    // Candidate sourcing: reach the people you would HIRE, not company
    // decision-makers. Function defaults to the engineering/product space and is
    // re-specified per mission by the synthesizer from the role being filled.
    functions: ['software engineering', 'engineering', 'data', 'machine learning', 'product', 'design'],
    functionKeywords: ['engineer', 'developer', 'data', 'machine learning', 'designer', 'product'],
    seniority: { idealLevels: ['senior_ic', 'lead'], maxLevel: 'manager' },
    // Exclude in-house recruiters/HR — you're poaching builders, not pitching a
    // recruiting service. (Flip these to flip the mode; CONTACT_ENGINE.md §7.)
    disqualifierKeywords: [...COMMON_DISQUALIFIERS, 'recruiter', 'talent acquisition', 'sourcer', 'human resources'],
    routerOk: false,
    rationale: 'Candidate sourcing: reach the ICs and team leads you would hire — matched on function and level — not company decision-makers or in-house recruiters.',
  },
  sales: {
    functions: ['operations', 'engineering', 'product', 'marketing', 'growth', 'finance', 'it'],
    functionKeywords: ['operations', 'engineering', 'product', 'growth', 'revenue'],
    seniority: { idealLevels: ['manager', 'senior_manager', 'director'], maxLevel: 'vp' },
    disqualifierKeywords: COMMON_DISQUALIFIERS,
    routerOk: false,
    rationale: 'The line manager/director who owns the painful workflow is the champion who replies and sells internally; the economic buyer comes after.',
  },
};

function dedupeStrings(...lists: Array<string[] | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const s of list ?? []) {
      const t = (s ?? '').trim();
      const key = t.toLowerCase();
      if (t && !seen.has(key)) {
        seen.add(key);
        out.push(t);
      }
    }
  }
  return out;
}

/** Build the deterministic, no-LLM ICP for a mode + optional geo. Always valid. */
export function defaultContactIcp(mode: MissionMode, geo?: string | null): ContactIcp {
  const prior = MODE_ICP_PRIOR[mode] ?? MODE_ICP_PRIOR.sales;
  return {
    functions: [...prior.functions],
    functionKeywords: [...prior.functionKeywords],
    seniority: { idealLevels: [...prior.seniority.idealLevels], maxLevel: prior.seniority.maxLevel },
    disqualifierKeywords: [...prior.disqualifierKeywords],
    routerOk: prior.routerOk,
    geo: { preferred: geo?.trim() || null, scope: 'global', strict: false },
    rationale: prior.rationale,
  };
}

interface RawIcp {
  functions?: string[];
  function_keywords?: string[];
  disqualifier_keywords?: string[];
  geo_scope?: string;
  rationale?: string;
}

const ICP_SCHEMA = {
  type: 'object',
  properties: {
    functions: { type: 'array', items: { type: 'string' } },
    function_keywords: { type: 'array', items: { type: 'string' } },
    disqualifier_keywords: { type: 'array', items: { type: 'string' } },
    geo_scope: { type: 'string', enum: ['metro', 'country', 'region', 'global'] },
    rationale: { type: 'string' },
  },
  required: ['functions'],
} as const;

/**
 * Merge an LLM-proposed ICP onto the deterministic prior. The LLM only gets to
 * adapt functions / keywords / disqualifiers / geo-scope / rationale; the
 * seniority band always comes from the prior so exec bias can't creep back in.
 */
export function normalizeIcp(mode: MissionMode, geo: string | null | undefined, raw: RawIcp | null): ContactIcp {
  const base = defaultContactIcp(mode, geo);
  if (!raw) return base;

  const functions = dedupeStrings(raw.functions, base.functions).slice(0, 12);
  const functionKeywords = dedupeStrings(raw.function_keywords, base.functionKeywords).slice(0, 12);
  const disqualifierKeywords = dedupeStrings(raw.disqualifier_keywords, base.disqualifierKeywords).slice(0, 20);
  const scope = (raw.geo_scope && ['metro', 'country', 'region', 'global'].includes(raw.geo_scope))
    ? (raw.geo_scope as ContactIcp['geo']['scope'])
    : base.geo.scope;

  return {
    functions: functions.length ? functions : base.functions,
    functionKeywords: functionKeywords.length ? functionKeywords : base.functionKeywords,
    seniority: base.seniority, // prior wins — never LLM-controlled
    disqualifierKeywords,
    routerOk: base.routerOk,
    geo: { preferred: geo?.trim() || null, scope, strict: base.geo.strict },
    rationale: (raw.rationale ?? '').trim() || base.rationale,
  };
}

export interface SynthesizeArgs {
  mode: MissionMode;
  goal: string;
  offerDetails?: string | null;
  targetDescription?: string | null;
  geo?: string | null;
}

/**
 * Adapt the per-mode prior to this specific mission via one LLM call. Falls back
 * to the deterministic default on any failure, so callers never hard-depend on
 * the network. Cache the result on the mission (CONTACT_ENGINE.md §8).
 */
export async function synthesizeContactIcp(args: SynthesizeArgs): Promise<ContactIcp> {
  const prior = MODE_ICP_PRIOR[args.mode] ?? MODE_ICP_PRIOR.sales;
  const userPrompt = [
    `Mode: ${args.mode}`,
    `Offer / what's being sent: ${args.goal}`,
    args.offerDetails ? `Offer details: ${args.offerDetails}` : '',
    args.targetDescription ? `Audience / who to reach: ${args.targetDescription}` : '',
    args.geo ? `Location focus: ${args.geo}` : 'Location focus: none',
    '',
    'PER-MODE PRIOR (the kind of person who replies for this mode):',
    `- target functions: ${prior.functions.join(', ')}`,
    `- seniority philosophy (fixed): ${prior.rationale}`,
    '',
    'Adapt ONLY the function focus, query synonyms, non-seniority disqualifiers, and geo scope to THIS offer and audience. Do NOT change the seniority band. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const { ok, data } = await generateJson<RawIcp>({
      model: MODEL(),
      max_tokens: 1024,
      temperature: 0.2,
      system: CONTACT_ICP_SYSTEM,
      responseJsonSchema: ICP_SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return normalizeIcp(args.mode, args.geo, ok ? (data ?? null) : null);
  } catch (err) {
    console.warn('synthesize_contact_icp_failed', err);
    return defaultContactIcp(args.mode, args.geo);
  }
}
