import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVerification, verdictAccepted } from './contact-verify';

describe('normalizeVerification', () => {
  it('passes through a well-formed match with research', () => {
    const v = normalizeVerification({
      verdict: 'match',
      confidence: 0.88,
      reason: 'Confirmed current Head of Partnerships',
      research: [{ fact: 'Spoke at re:Invent 2025', source_url: 'https://x.co', source_title: 'Talk' }],
    });
    assert.equal(v.verdict, 'match');
    assert.equal(v.confidence, 0.88);
    assert.equal(v.research.length, 1);
    assert.equal(v.research[0].sourceUrl, 'https://x.co');
  });

  it('treats an unknown/garbage verdict as weak, not a free match', () => {
    assert.equal(normalizeVerification({ verdict: 'probably?' }).verdict, 'weak');
    assert.equal(normalizeVerification({}).verdict, 'weak');
  });

  it('clamps confidence and defaults a missing reason', () => {
    assert.equal(normalizeVerification({ verdict: 'match', confidence: 5 }).confidence, 1);
    assert.equal(normalizeVerification({ verdict: 'match', confidence: -2 }).confidence, 0);
    assert.equal(normalizeVerification({ verdict: 'match' }).confidence, 0.5);
    assert.equal(normalizeVerification({ verdict: 'mismatch' }).reason, 'no reason given');
  });

  it('drops blank facts, caps research at 4, normalizes missing sources to null', () => {
    const research = Array.from({ length: 6 }, (_, i) => ({ fact: `fact ${i}` }));
    research.push({ fact: '   ' } as never);
    const v = normalizeVerification({ verdict: 'match', research });
    assert.equal(v.research.length, 4);
    assert.equal(v.research[0].sourceUrl, null);
    assert.equal(v.research[0].sourceTitle, null);
  });
});

describe('verdictAccepted', () => {
  it('keeps match and weak, drops only mismatch', () => {
    assert.equal(verdictAccepted({ verdict: 'match', confidence: 1, reason: '', research: [] }), true);
    assert.equal(verdictAccepted({ verdict: 'weak', confidence: 0.2, reason: '', research: [] }), true);
    assert.equal(verdictAccepted({ verdict: 'mismatch', confidence: 0.9, reason: '', research: [] }), false);
  });
});
