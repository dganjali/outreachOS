import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moderate, contentHash, type ModerationLlm, type ModerationVerdict } from './content-moderation';

function fakeLlm(verdict: ModerationVerdict): { fn: ModerationLlm; calls: () => number } {
  let n = 0;
  return {
    fn: async () => {
      n++;
      return verdict;
    },
    calls: () => n,
  };
}

const ALLOW: ModerationVerdict = { allowed: true, category: null, reason: 'ok' };
const BLOCK: ModerationVerdict = { allowed: false, category: 'phishing', reason: 'asks for password' };

describe('contentHash', () => {
  it('is stable for the same text and differs when text changes', () => {
    assert.equal(contentHash('a', 'b'), contentHash('a', 'b'));
    assert.notEqual(contentHash('a', 'b'), contentHash('a', 'b2'));
  });
});

describe('moderate', () => {
  it('returns the LLM verdict when there is no cache', async () => {
    const llm = fakeLlm(BLOCK);
    const r = await moderate({ subject: 's', body: 'b' }, { llm: llm.fn });
    assert.equal(r.verdict.allowed, false);
    assert.equal(r.verdict.category, 'phishing');
    assert.equal(r.fromCache, false);
    assert.equal(llm.calls(), 1);
  });

  it('skips the LLM when the cache hash matches the content', async () => {
    const llm = fakeLlm(ALLOW);
    const hash = contentHash('s', 'b');
    const r = await moderate(
      { subject: 's', body: 'b' },
      { llm: llm.fn, cache: { allowed: false, category: 'scam', contentHash: hash, checkedAt: new Date() } },
    );
    assert.equal(r.fromCache, true);
    assert.equal(r.verdict.allowed, false); // served from cache, not the fake llm
    assert.equal(llm.calls(), 0);
  });

  it('re-checks (calls the LLM) when the content changed since the cache', async () => {
    const llm = fakeLlm(ALLOW);
    const staleHash = contentHash('old', 'text');
    const r = await moderate(
      { subject: 's', body: 'b' },
      { llm: llm.fn, cache: { allowed: false, category: 'scam', contentHash: staleHash, checkedAt: new Date() } },
    );
    assert.equal(r.fromCache, false);
    assert.equal(r.verdict.allowed, true);
    assert.equal(llm.calls(), 1);
  });
});
