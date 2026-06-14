// Seniority taxonomy, title parsing, size-relative banding, and the composite
// reply-likelihood score. The deterministic core of the Contact Discovery
// Engine (CONTACT_ENGINE.md §3/§5) - no network, no LLM, fully unit-testable.
//
// This is where the "contacts are too high up" problem is actually solved: a raw
// title becomes a normalized seniority rank, the acceptable band shifts with the
// target's company size, and anything above the cap is dropped or down-ranked.

import type { ContactIcp, SeniorityLevel, SizeTier } from '../../shared/types';

// Junior → senior. Gaps are intentional-free; ranks are contiguous so band math
// is simple integer comparison.
export const SENIORITY_RANK: Record<SeniorityLevel, number> = {
  ic: 1,
  senior_ic: 2,
  lead: 3,
  manager: 4,
  senior_manager: 5,
  director: 6,
  senior_director: 7,
  vp: 8,
  svp: 9,
  cxo: 10,
  founder: 11,
};

/** Rank for a level (helper to keep band tables readable). */
export function rank(level: SeniorityLevel): number {
  return SENIORITY_RANK[level];
}

export type GeoScopeTag = 'global' | 'regional' | 'national' | null;

export interface ParsedTitle {
  level: SeniorityLevel | null; // null = couldn't classify
  rank: number; // 0 when level is null (treated as "unknown", neutral)
  isRouter: boolean; // coordinator / assistant / EA - a gatekeeper, not the owner
  scope: GeoScopeTag; // "Global"/"Regional" qualifiers amplify effective seniority
}

// Order matters: probe the most senior signals first so "Senior Vice President"
// is svp (not vp, not "senior … manager"), and "Vice President" is vp (not
// president→founder).
export function parseSeniority(rawTitle: string | null | undefined): ParsedTitle {
  const title = (rawTitle ?? '').toLowerCase().trim();
  if (!title) return { level: null, rank: 0, isRouter: false, scope: null };

  const scope = parseScope(title);
  const isRouter = /\b(coordinator|assistant|administrative|receptionist|secretary|ea to|executive assistant)\b/.test(
    title
  );

  const level = classifyLevel(title);
  return { level, rank: level ? SENIORITY_RANK[level] : 0, isRouter, scope };
}

function parseScope(title: string): GeoScopeTag {
  if (/\b(global|international|worldwide)\b/.test(title)) return 'global';
  if (/\b(regional|emea|apac|amer|americas|latam|north america)\b/.test(title)) return 'regional';
  if (/\b(national|country)\b/.test(title)) return 'national';
  return null;
}

function classifyLevel(title: string): SeniorityLevel | null {
  // founder / owner / president (but NOT "vice president" → that's vp/svp below)
  if (/\b(founder|co-?founder|owner|proprietor|managing partner|general partner)\b/.test(title)) return 'founder';
  if (/\bpresident\b/.test(title) && !/\bvice\s+president\b/.test(title) && !/\bvp\b/.test(title)) return 'founder';

  // C-suite: "Chief X Officer", "CxO", "C-level"
  if (/\bchief\b/.test(title) || /\bc[teiofmxadr]o\b/.test(title) || /\bc-level\b/.test(title)) return 'cxo';

  // SVP / EVP / executive|senior vice president
  if (/\b(svp|evp)\b/.test(title) || /\b(senior|executive)\s+vice\s+president\b/.test(title)) return 'svp';

  // VP / vice president
  if (/\bvp\b/.test(title) || /\bvice\s+president\b/.test(title)) return 'vp';

  // Senior Director / Sr. Director
  if (/\b(senior|sr\.?)\s+director\b/.test(title)) return 'senior_director';

  // Director / Head of … (head treated as director-equivalent)
  if (/\bdirector\b/.test(title) || /\bhead\s+(of|,)\b/.test(title) || /\bhead\b/.test(title)) return 'director';

  // Senior <function> Manager - "Senior Community Investment Manager"
  if (/\b(senior|sr\.?)\b[\w\s,&./-]*\bmanager\b/.test(title)) return 'senior_manager';

  // Manager
  if (/\bmanager\b/.test(title) || /\bmgr\b/.test(title)) return 'manager';

  // Lead - "BD Lead", "Team Lead", "Engineering Lead"
  if (/\blead\b/.test(title)) return 'lead';

  // Senior IC - principal/staff or "Senior <role>"
  if (/\b(principal|staff)\b/.test(title)) return 'senior_ic';
  if (/\b(senior|sr\.?)\b/.test(title)) return 'senior_ic';

  // Anything left that looks like a real role (engineer, analyst, recruiter,
  // designer, specialist, associate, coordinator, etc.) is an individual
  // contributor.
  if (/\b(engineer|developer|analyst|recruiter|designer|specialist|associate|scientist|researcher|consultant|representative|officer|advisor|strategist|producer|writer|editor|coordinator|administrator|generalist|planner|clerk|agent|fellow|intern|apprentice|technician|liaison|ambassador)\b/.test(title)) {
    return 'ic';
  }
  return null; // genuinely unclassifiable
}

// ---------------------------------------------------------------------------
// Company size → seniority band. The acceptable band slides down as the company
// grows, so the same mission targets a startup's founder but an enterprise's
// program manager (CONTACT_ENGINE.md §3.2).
// ---------------------------------------------------------------------------

export interface Band {
  idealMin: number;
  idealMax: number;
  hardMax: number;
}

const SIZE_BAND: Record<SizeTier | 'unknown', Band> = {
  startup: { idealMin: rank('director'), idealMax: rank('founder'), hardMax: rank('founder') },
  small: { idealMin: rank('manager'), idealMax: rank('vp'), hardMax: rank('vp') },
  mid: { idealMin: rank('manager'), idealMax: rank('director'), hardMax: rank('senior_director') },
  large: { idealMin: rank('manager'), idealMax: rank('director'), hardMax: rank('senior_director') },
  enterprise: { idealMin: rank('manager'), idealMax: rank('senior_manager'), hardMax: rank('director') },
  unknown: { idealMin: rank('manager'), idealMax: rank('director'), hardMax: rank('vp') },
};

/** Map a headcount to a size tier. null when unknown → the *unknown* band. */
export function sizeTierFromCount(count: number | null | undefined): SizeTier | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  if (count < 50) return 'startup';
  if (count < 250) return 'small';
  if (count < 2000) return 'mid';
  if (count < 10000) return 'large';
  return 'enterprise';
}

/**
 * Combine the mission ICP's desired band with the target's size band. The size
 * band only ever makes the cap STRICTER - so a mode that wants directors still
 * gets program managers at an enterprise, and the cap drops execs.
 */
export function effectiveBand(icp: ContactIcp, sizeTier: SizeTier | null): Band {
  const size = SIZE_BAND[sizeTier ?? 'unknown'];
  const icpIdeal = (icp.seniority.idealLevels.length ? icp.seniority.idealLevels : (['manager', 'director'] as SeniorityLevel[])).map(rank);
  const icpMax = rank(icp.seniority.maxLevel);

  const hardMax = Math.min(icpMax, size.hardMax);
  const idealMax = Math.min(Math.max(...icpIdeal), size.idealMax, hardMax);
  const idealMin = Math.min(Math.min(...icpIdeal), size.idealMin, idealMax);
  return { idealMin, idealMax, hardMax };
}

// ---------------------------------------------------------------------------
// Function matching - does the title/headline sit in the right function?
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(['and', 'the', 'of', 'for', 'to', 'in', 'on', '&', 'a']);

/** Functions (by phrase or distinctive word) that appear in the given text. */
export function matchFunctions(text: string, functions: string[]): string[] {
  const hay = (text ?? '').toLowerCase();
  if (!hay) return [];
  const out: string[] = [];
  for (const fn of functions) {
    const phrase = fn.toLowerCase().trim();
    if (!phrase) continue;
    if (hay.includes(phrase)) {
      out.push(fn);
      continue;
    }
    // Phrase not verbatim - accept if a distinctive (>3 char) word matches.
    const words = phrase.split(/[\s/&-]+/).filter((w) => w.length > 3 && !STOPWORDS.has(w));
    if (words.some((w) => hay.includes(w))) out.push(fn);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geo fit
// ---------------------------------------------------------------------------

/** 0..1 how well a contact's location matches the ICP geo preference. */
export function geoFitScore(location: string | null | undefined, geo: ContactIcp['geo']): number {
  if (!geo?.preferred) return 1; // no preference → everyone fits
  const loc = (location ?? '').toLowerCase();
  if (!loc) return 0.6; // unknown location - don't punish hard, just slightly
  const tokens = geo.preferred
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const hit = tokens.some((t) => loc.includes(t));
  if (hit) return 1;
  return geo.strict ? 0.1 : 0.45;
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

// The single tuning surface (CONTACT_ENGINE.md §5/§9). Sum ≈ 1.0; band carries
// the size-relative weight since the band is itself size-shifted.
export const SCORE_WEIGHTS = { func: 0.3, band: 0.4, geo: 0.15, conf: 0.15 } as const;

export interface ScoreInput {
  title: string;
  headline?: string | null;
  location?: string | null;
  llmConfidence?: number | null; // 0..1
  icp: ContactIcp;
  sizeTier: SizeTier | null;
  // Allow keeping a candidate above the size cap (only when the pool would
  // otherwise be empty). Surfaced with a flag - never silent.
  allowAboveCap?: boolean;
}

export interface ScoredContact {
  score: number; // 0..1 composite reply-likelihood
  level: SeniorityLevel | null;
  rank: number;
  inBand: boolean;
  disqualified: boolean;
  matchedFunctions: string[];
  reasons: string[]; // decision log
}

function seniorityBandFit(r: number, band: Band): number {
  if (r === 0) return 0.5; // unknown level - neutral
  if (r > band.hardMax) return 0;
  if (r >= band.idealMin && r <= band.idealMax) return 1;
  if (r < band.idealMin) return Math.max(0.3, 1 - (band.idealMin - r) * 0.15); // too junior, gentle
  return Math.max(0.1, 1 - (r - band.idealMax) * 0.3); // above ideal but ≤ cap - too senior
}

/**
 * Score one candidate for reply-likelihood and decide whether it survives the
 * hard filters. Returns a decision log either way.
 */
export function scoreContact(input: ScoreInput): ScoredContact {
  const { title, headline, location, icp, sizeTier } = input;
  const parsed = parseSeniority(title);
  const band = effectiveBand(icp, sizeTier);
  const text = `${title ?? ''} ${headline ?? ''}`.trim();
  const reasons: string[] = [];

  // Hard filter 1 - explicit non-seniority disqualifiers (former/retired/intern…
  // and any title substring the ICP listed). Seniority is handled by the band,
  // not these, so they stay size-independent.
  const lowered = text.toLowerCase();
  const disqualHit = (icp.disqualifierKeywords ?? []).find((k) => k && lowered.includes(k.toLowerCase()));
  if (disqualHit) {
    reasons.push(`disqualified: matches "${disqualHit}"`);
    return { score: 0, level: parsed.level, rank: parsed.rank, inBand: false, disqualified: true, matchedFunctions: [], reasons };
  }

  const matched = matchFunctions(text, icp.functions);
  const aboveCap = parsed.rank > band.hardMax;

  // Hard filter 2 - above the size cap AND off-function. A senior exec in the
  // WRONG function (a Global CMO for a community-investment mission) is the
  // classic "too high up" miss → drop. An above-cap person who IS on-function
  // ("SVP, Community") is kept as a low-ranked fallback, never silently dropped.
  if (aboveCap && matched.length === 0 && !input.allowAboveCap) {
    reasons.push(`above cap & off-function: ${parsed.level} (rank ${parsed.rank}) > cap ${band.hardMax} for ${sizeTier ?? 'unknown'} size`);
    return { score: 0, level: parsed.level, rank: parsed.rank, inBand: false, disqualified: true, matchedFunctions: matched, reasons };
  }

  const funcScore = matched.length >= 1 ? 1 : 0.3;
  let bandScore = seniorityBandFit(parsed.rank, band);
  if (aboveCap) {
    bandScore = 0.2; // on-function but above cap - strong penalty, not elimination
    reasons.push('above cap but on-function - kept as down-ranked fallback');
  }
  const geoScore = geoFitScore(location, icp.geo);
  const conf = clamp01(input.llmConfidence ?? 0.5);

  let score =
    SCORE_WEIGHTS.func * funcScore +
    SCORE_WEIGHTS.band * bandScore +
    SCORE_WEIGHTS.geo * geoScore +
    SCORE_WEIGHTS.conf * conf;

  // Router penalty unless the ICP welcomes routers (e.g. event coordinators).
  if (parsed.isRouter && !icp.routerOk) {
    score *= 0.6;
    reasons.push('router/gatekeeper down-ranked (routerOk=false)');
  }
  // Global-scope execs are less reachable even when within the cap.
  if (parsed.scope === 'global' && parsed.rank >= rank('director')) {
    score *= 0.85;
    reasons.push('global-scope senior title slightly down-ranked');
  }
  if (input.allowAboveCap && parsed.rank > band.hardMax) {
    reasons.push('kept above cap (pool would otherwise be empty)');
  }

  const inBand = parsed.rank >= band.idealMin && parsed.rank <= band.idealMax;
  reasons.push(
    `level=${parsed.level ?? 'unknown'} band=[${band.idealMin},${band.idealMax}] cap=${band.hardMax} func=${matched.length} geo=${geoScore.toFixed(2)}`
  );

  return {
    score: clamp01(score),
    level: parsed.level,
    rank: parsed.rank,
    inBand,
    disqualified: false,
    matchedFunctions: matched,
    reasons,
  };
}

function clamp01(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
