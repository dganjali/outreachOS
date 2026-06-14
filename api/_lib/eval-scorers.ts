// Pure scorers for the eval harness (scripts/eval). Kept here — not in scripts/ —
// so they run under the unit-test runner (api/**/*.test.ts). Given an engine
// result + its grounding context, they turn "is it slop?" into numbers:
// grounding %, slop-flag count, constraint pass, voice match. No LLM, no DB.

export interface ScoreInput {
  allowedFactIds: string[];
  claims: Array<{ text: string; factId: string }>;
  violations: Array<{ type: string; severity: 'block' | 'warn' }>;
  voiceMatchScore: number;
  bodyWordCount: number;
  minWords: number;
  maxWords: number;
  pass: boolean;
}

export interface Scorecard {
  groundingRate: number; // 0..1 — claims attributed to a real allowed fact
  ungroundedClaims: number;
  slopFlags: number; // banned_phrase + slop + voice_mismatch violations
  blockViolations: number;
  warnViolations: number;
  constraintPass: boolean; // body within word bounds
  voiceMatchScore: number; // 0..1, from the judge
  pass: boolean;
}

const SLOP_TYPES = new Set(['banned_phrase', 'slop', 'voice_mismatch']);

export function scoreDraft(i: ScoreInput): Scorecard {
  const allowed = new Set(i.allowedFactIds);
  const claims = i.claims ?? [];
  const grounded = claims.filter((c) => {
    const fid = (c.factId ?? '').trim();
    return fid && fid.toLowerCase() !== 'none' && allowed.has(fid);
  }).length;
  const ungroundedClaims = claims.length - grounded;
  // No claims = perfectly grounded (nothing asserted ⇒ nothing to fabricate).
  const groundingRate = claims.length === 0 ? 1 : grounded / claims.length;

  const violations = i.violations ?? [];
  const slopFlags = violations.filter((v) => SLOP_TYPES.has(v.type)).length;
  const blockViolations = violations.filter((v) => v.severity === 'block').length;
  const warnViolations = violations.filter((v) => v.severity === 'warn').length;

  const constraintPass = i.bodyWordCount >= i.minWords && i.bodyWordCount <= i.maxWords;

  return {
    groundingRate,
    ungroundedClaims,
    slopFlags,
    blockViolations,
    warnViolations,
    constraintPass,
    voiceMatchScore: clamp01(i.voiceMatchScore),
    pass: i.pass,
  };
}

export interface Aggregate {
  count: number;
  avgGroundingRate: number;
  totalUngroundedClaims: number;
  avgSlopFlags: number;
  avgVoiceMatchScore: number;
  constraintPassRate: number;
  passRate: number;
}

export function aggregate(cards: Scorecard[]): Aggregate {
  const n = cards.length;
  if (n === 0) {
    return {
      count: 0,
      avgGroundingRate: 0,
      totalUngroundedClaims: 0,
      avgSlopFlags: 0,
      avgVoiceMatchScore: 0,
      constraintPassRate: 0,
      passRate: 0,
    };
  }
  const sum = (f: (c: Scorecard) => number) => cards.reduce((a, c) => a + f(c), 0);
  return {
    count: n,
    avgGroundingRate: sum((c) => c.groundingRate) / n,
    totalUngroundedClaims: sum((c) => c.ungroundedClaims),
    avgSlopFlags: sum((c) => c.slopFlags) / n,
    avgVoiceMatchScore: sum((c) => c.voiceMatchScore) / n,
    constraintPassRate: sum((c) => (c.constraintPass ? 1 : 0)) / n,
    passRate: sum((c) => (c.pass ? 1 : 0)) / n,
  };
}

/**
 * Regression check vs a committed baseline. A metric regresses if it moves the
 * wrong way by more than `eps` (default 2 points). Returns human-readable lines;
 * empty ⇒ no regressions.
 */
export function diffAggregate(baseline: Aggregate, current: Aggregate, eps = 0.02): string[] {
  const out: string[] = [];
  const worseLower = (name: string, b: number, c: number) => {
    if (c < b - eps) out.push(`${name} regressed: ${b.toFixed(3)} → ${c.toFixed(3)}`);
  };
  const worseHigher = (name: string, b: number, c: number) => {
    if (c > b + eps) out.push(`${name} worsened: ${b.toFixed(3)} → ${c.toFixed(3)}`);
  };
  worseLower('avgGroundingRate', baseline.avgGroundingRate, current.avgGroundingRate);
  worseLower('avgVoiceMatchScore', baseline.avgVoiceMatchScore, current.avgVoiceMatchScore);
  worseLower('constraintPassRate', baseline.constraintPassRate, current.constraintPassRate);
  worseLower('passRate', baseline.passRate, current.passRate);
  worseHigher('avgSlopFlags', baseline.avgSlopFlags, current.avgSlopFlags);
  return out;
}

/** Cosine similarity of two equal-length vectors (voice-centroid distance). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
