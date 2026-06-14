// Unit tests for the eval scorers — pure math, no LLM/DB. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreDraft,
  aggregate,
  diffAggregate,
  cosineSimilarity,
  type ScoreInput,
  type Scorecard,
} from './eval-scorers';

const base: ScoreInput = {
  allowedFactIds: ['f1', 'f2'],
  claims: [
    { text: 'a', factId: 'f1' },
    { text: 'b', factId: 'f2' },
  ],
  violations: [],
  voiceMatchScore: 0.8,
  bodyWordCount: 60,
  minWords: 20,
  maxWords: 120,
  pass: true,
};

test('fully grounded draft scores groundingRate 1', () => {
  const s = scoreDraft(base);
  assert.equal(s.groundingRate, 1);
  assert.equal(s.ungroundedClaims, 0);
  assert.equal(s.constraintPass, true);
});

test('an unknown factId lowers groundingRate and counts ungrounded', () => {
  const s = scoreDraft({ ...base, claims: [{ text: 'a', factId: 'f1' }, { text: 'x', factId: 'f9' }] });
  assert.equal(s.groundingRate, 0.5);
  assert.equal(s.ungroundedClaims, 1);
});

test('empty/none factIds are ungrounded', () => {
  const s = scoreDraft({ ...base, claims: [{ text: 'a', factId: '' }, { text: 'b', factId: 'none' }] });
  assert.equal(s.groundingRate, 0);
  assert.equal(s.ungroundedClaims, 2);
});

test('no claims = perfectly grounded', () => {
  const s = scoreDraft({ ...base, claims: [] });
  assert.equal(s.groundingRate, 1);
});

test('slop + block + warn counts split by type/severity', () => {
  const s = scoreDraft({
    ...base,
    violations: [
      { type: 'banned_phrase', severity: 'block' },
      { type: 'voice_mismatch', severity: 'warn' },
      { type: 'constraint', severity: 'warn' },
    ],
  });
  assert.equal(s.slopFlags, 2); // banned_phrase + voice_mismatch
  assert.equal(s.blockViolations, 1);
  assert.equal(s.warnViolations, 2);
});

test('constraintPass false when out of word bounds', () => {
  assert.equal(scoreDraft({ ...base, bodyWordCount: 5 }).constraintPass, false);
  assert.equal(scoreDraft({ ...base, bodyWordCount: 999 }).constraintPass, false);
});

test('aggregate averages over cards', () => {
  const cards: Scorecard[] = [scoreDraft(base), scoreDraft({ ...base, voiceMatchScore: 0.4, pass: false })];
  const agg = aggregate(cards);
  assert.equal(agg.count, 2);
  assert.ok(Math.abs(agg.avgVoiceMatchScore - 0.6) < 1e-9);
  assert.equal(agg.passRate, 0.5);
});

test('diffAggregate flags grounding regression and slop increase', () => {
  const b = aggregate([scoreDraft(base)]);
  const worse = aggregate([
    scoreDraft({ ...base, claims: [{ text: 'x', factId: 'f9' }], violations: [{ type: 'slop', severity: 'warn' }] }),
  ]);
  const lines = diffAggregate(b, worse);
  assert.equal(lines.some((l) => /avgGroundingRate regressed/.test(l)), true);
  assert.equal(lines.some((l) => /avgSlopFlags worsened/.test(l)), true);
});

test('diffAggregate is empty when identical', () => {
  const b = aggregate([scoreDraft(base)]);
  assert.deepEqual(diffAggregate(b, b), []);
});

test('cosineSimilarity: identical=1, orthogonal=0, mismatched-length=0', () => {
  assert.equal(Math.round(cosineSimilarity([1, 2, 3], [1, 2, 3]) * 1000) / 1000, 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
});
