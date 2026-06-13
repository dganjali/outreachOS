// Unit tests for the personalization engine's deterministic verifier — the
// grounding contract that makes the difference between personalization and
// slop. No LLM/DB: these are pure functions. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyDraftDeterministic,
  hasBlocker,
  type AllowedFact,
  type DraftOutput,
} from './engine';

const FACTS: AllowedFact[] = [
  { id: 'f1', claim: 'Ran a 1,400-person developer conference', source: 'context_fact' },
  { id: 'f2', claim: 'Acme raised a $20M Series B last month', source: 'evidence' },
];

function draft(over: Partial<DraftOutput> = {}): DraftOutput {
  return {
    angle: 'community fit',
    subject: 'quick one on your Series B',
    body: 'Saw Acme raised a $20M Series B. I run a 1,400-person dev conference and think there is overlap. Worth 15 minutes next week?',
    claims: [
      { text: 'Acme raised a $20M Series B', factId: 'f2' },
      { text: 'I run a 1,400-person dev conference', factId: 'f1' },
    ],
    ...over,
  };
}

test('a fully-grounded draft passes (no block violations)', () => {
  const v = verifyDraftDeterministic(draft(), FACTS, { bannedPhrases: [] });
  assert.equal(hasBlocker(v), false);
});

test('a claim attributed to an unknown factId is a fabrication blocker', () => {
  const v = verifyDraftDeterministic(
    draft({ claims: [{ text: 'They have 5M users', factId: 'f9' }] }),
    FACTS,
  );
  assert.equal(v.some((x) => x.type === 'fabrication' && x.severity === 'block'), true);
  assert.equal(hasBlocker(v), true);
});

test('an unattributed claim (empty or "none" factId) is a fabrication blocker', () => {
  for (const factId of ['', '  ', 'none', 'NONE']) {
    const v = verifyDraftDeterministic(
      draft({ claims: [{ text: 'They are the market leader', factId }] }),
      FACTS,
    );
    assert.equal(hasBlocker(v), true, `factId="${factId}" should block`);
  }
});

test('a banned phrase is a blocker (case-insensitive)', () => {
  const v = verifyDraftDeterministic(
    draft({ body: 'I hope this finds you well. Saw your Series B — worth 15 min?' }),
    FACTS,
    { bannedPhrases: ['I hope this finds you well'] },
  );
  assert.equal(v.some((x) => x.type === 'banned_phrase'), true);
  assert.equal(hasBlocker(v), true);
});

test('over-length body warns but does not block', () => {
  const long = Array.from({ length: 200 }, () => 'word').join(' ');
  const v = verifyDraftDeterministic(draft({ body: long }), FACTS, { maxWords: 120 });
  assert.equal(v.some((x) => x.type === 'constraint' && x.severity === 'warn'), true);
  assert.equal(hasBlocker(v), false);
});

test('a draft with no claims and no banned phrases has no blockers', () => {
  const v = verifyDraftDeterministic(draft({ claims: [] }), FACTS, { bannedPhrases: [] });
  assert.equal(hasBlocker(v), false);
});

test('deliverability heuristics (spam words) warn but never block', () => {
  const v = verifyDraftDeterministic(
    draft({ body: 'Act now! This is a limited time risk-free offer — worth 15 min next week?' }),
    FACTS,
    { bannedPhrases: [] },
  );
  assert.equal(v.some((x) => x.type === 'constraint' && x.severity === 'warn'), true);
  assert.equal(hasBlocker(v), false);
});

test('a draft with no call-to-action gets a constraint warning', () => {
  const v = verifyDraftDeterministic(
    draft({ body: 'I run a 1,400-person dev conference and saw Acme raised a Series B.' }),
    FACTS,
    { bannedPhrases: [] },
  );
  assert.equal(
    v.some((x) => x.type === 'constraint' && /call-to-action/i.test(x.detail)),
    true,
  );
  assert.equal(hasBlocker(v), false);
});
