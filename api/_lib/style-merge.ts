// Confidence-weighted StyleProfile merge - the heart of the learning loop's
// "memory, not a diff prompt" promise. A single noisy calibration sample must
// NEVER overwrite a dimension we're already confident about; evidence instead
// accumulates. The math: a new observation pulls the value toward itself in
// proportion to its OWN confidence relative to the accumulated confidence, and
// confidence ratchets up (never down) as evidence stacks. A low-confidence
// sample against a high-confidence dimension barely moves it - by construction.
//
// Pure (no LLM/DB) so it's unit-testable. The LLM (extract-style.ts) produces
// the delta; this decides how much of it to believe.

import { DEFAULT_TEMPLATE_STRICTNESS } from '../../shared/schemas';
import type { StyleProfile, StyleDimension } from '../../shared/schemas';

export interface StyleDelta {
  dimensions?: Record<string, { value: number; confidence: number }>;
  rules?: Array<{ rule: string; confidence: number }>;
  bannedPhrases?: string[];
  voiceSummary?: string;
}

function mergeDimension(cur: StyleDimension | undefined, next: { value: number; confidence: number }, source: string): StyleDimension {
  const nc = clamp01(next.confidence);
  if (!cur) return { value: next.value, confidence: nc, source };
  const cc = clamp01(cur.confidence);
  // Confidence-weighted average - a weak sample barely moves a strong value.
  const denom = cc + nc;
  const value = denom === 0 ? next.value : (cur.value * cc + next.value * nc) / denom;
  // Evidence accumulates: confidence ratchets toward 1, never drops.
  const confidence = clamp01(cc + nc * (1 - cc));
  return { value, confidence, source };
}

export function mergeStyleProfile(cur: StyleProfile, delta: StyleDelta, source: string): StyleProfile {
  // Dimensions
  const dimensions: Record<string, StyleDimension> = { ...(cur.dimensions ?? {}) };
  for (const [name, d] of Object.entries(delta.dimensions ?? {})) {
    dimensions[name] = mergeDimension(dimensions[name], d, source);
  }

  // Rules - dedupe by normalized text; keep the higher confidence.
  const rules = [...(cur.rules ?? [])];
  const ruleIndex = new Map(rules.map((r, i) => [r.rule.trim().toLowerCase(), i]));
  for (const r of delta.rules ?? []) {
    const key = r.rule.trim().toLowerCase();
    if (!key) continue;
    const at = ruleIndex.get(key);
    if (at === undefined) {
      ruleIndex.set(key, rules.length);
      rules.push({ rule: r.rule.trim(), source, confidence: clamp01(r.confidence) });
    } else if (clamp01(r.confidence) > rules[at].confidence) {
      rules[at] = { rule: rules[at].rule, source, confidence: clamp01(r.confidence) };
    }
  }

  // Banned phrases - case-insensitive union.
  const seen = new Set<string>();
  const bannedPhrases: string[] = [];
  for (const p of [...(cur.bannedPhrases ?? []), ...(delta.bannedPhrases ?? [])]) {
    const key = p.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    bannedPhrases.push(p.trim());
  }

  const voiceSummary = delta.voiceSummary?.trim() ? delta.voiceSummary.trim() : cur.voiceSummary;

  // templateStrictness is a user-set knob, not something calibration infers - carry
  // it through untouched so a re-extract never silently resets the slider.
  return {
    dimensions,
    rules,
    bannedPhrases,
    voiceSummary,
    templateStrictness: cur.templateStrictness ?? DEFAULT_TEMPLATE_STRICTNESS,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
