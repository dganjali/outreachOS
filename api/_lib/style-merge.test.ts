// Unit tests for the confidence-weighted StyleProfile merge — the guarantee
// that one noisy sample can't wreck a learned voice. Pure math. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStyleProfile, type StyleDelta } from './style-merge';
import { emptyStyleProfile, type StyleProfile } from '../../shared/schemas';

function profile(over: Partial<StyleProfile> = {}): StyleProfile {
  return { ...emptyStyleProfile(), ...over };
}

test('a new dimension is added with the delta confidence', () => {
  const out = mergeStyleProfile(profile(), { dimensions: { formality: { value: 0.2, confidence: 0.8 } } }, 'chat');
  assert.equal(out.dimensions.formality.value, 0.2);
  assert.equal(out.dimensions.formality.confidence, 0.8);
  assert.equal(out.dimensions.formality.source, 'chat');
});

test('a LOW-confidence sample barely moves a HIGH-confidence dimension', () => {
  const cur = profile({ dimensions: { formality: { value: 0.2, confidence: 0.9, source: 'onboarding' } } });
  const out = mergeStyleProfile(cur, { dimensions: { formality: { value: 1.0, confidence: 0.1 } } }, 'edit');
  // weighted avg = (0.2*0.9 + 1.0*0.1)/(1.0) = 0.28 — stays close to 0.2, NOT 1.0
  assert.ok(out.dimensions.formality.value < 0.3, `expected <0.3, got ${out.dimensions.formality.value}`);
  // confidence ratchets up, never down
  assert.ok(out.dimensions.formality.confidence >= 0.9);
});

test('a HIGH-confidence sample meaningfully moves a LOW-confidence dimension', () => {
  const cur = profile({ dimensions: { warmth: { value: 0.2, confidence: 0.2, source: 'default' } } });
  const out = mergeStyleProfile(cur, { dimensions: { warmth: { value: 0.9, confidence: 0.9 } } }, 'chat');
  // weighted avg = (0.2*0.2 + 0.9*0.9)/1.1 ≈ 0.77
  assert.ok(out.dimensions.warmth.value > 0.6, `expected >0.6, got ${out.dimensions.warmth.value}`);
});

test('confidence never decreases', () => {
  const cur = profile({ dimensions: { d: { value: 0.5, confidence: 0.95, source: 'x' } } });
  const out = mergeStyleProfile(cur, { dimensions: { d: { value: 0.1, confidence: 0.3 } } }, 'y');
  assert.ok(out.dimensions.d.confidence >= 0.95);
});

test('rules dedupe by text and keep the higher confidence', () => {
  const cur = profile({ rules: [{ rule: 'Be concise', source: 'a', confidence: 0.4 }] });
  const delta: StyleDelta = { rules: [{ rule: 'be concise', confidence: 0.9 }, { rule: 'No emojis', confidence: 0.7 }] };
  const out = mergeStyleProfile(cur, delta, 'chat');
  assert.equal(out.rules.length, 2);
  const concise = out.rules.find((r) => /concise/i.test(r.rule))!;
  assert.equal(concise.confidence, 0.9);
});

test('banned phrases are case-insensitively unioned', () => {
  const cur = profile({ bannedPhrases: ['Circle back'] });
  const out = mergeStyleProfile(cur, { bannedPhrases: ['circle back', 'synergy'] }, 'chat');
  assert.equal(out.bannedPhrases.length, 2);
});

test('voiceSummary is replaced only when the delta provides one', () => {
  const cur = profile({ voiceSummary: 'original' });
  assert.equal(mergeStyleProfile(cur, {}, 's').voiceSummary, 'original');
  assert.equal(mergeStyleProfile(cur, { voiceSummary: 'updated' }, 's').voiceSummary, 'updated');
  assert.equal(mergeStyleProfile(cur, { voiceSummary: '   ' }, 's').voiceSummary, 'original');
});

test('out-of-range confidences are clamped to [0,1]', () => {
  const out = mergeStyleProfile(profile(), { dimensions: { d: { value: 0.5, confidence: 5 } } }, 's');
  assert.ok(out.dimensions.d.confidence <= 1);
});
