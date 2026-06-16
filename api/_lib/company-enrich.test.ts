import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickDomainFromResults,
  parseEmployeeCount,
  guessDomainCandidates,
  guessDomainByName,
} from './company-enrich';
import type { SerperOrganicResult } from './serper';

function r(link: string): SerperOrganicResult {
  return { title: '', link, snippet: '' };
}

describe('pickDomainFromResults', () => {
  it('skips aggregator results and returns the first real company domain', () => {
    const results = [
      r('https://www.linkedin.com/company/sierra'),
      r('https://en.wikipedia.org/wiki/Sierra'),
      r('https://crunchbase.com/organization/sierra'),
      r('https://sierra.ai/about'),
    ];
    assert.equal(pickDomainFromResults(results), 'sierra.ai');
  });

  it('normalizes www + path off the chosen link', () => {
    assert.equal(pickDomainFromResults([r('https://www.acme.co/contact')]), 'acme.co');
  });

  it('returns null when every result is an aggregator', () => {
    const results = [
      r('https://twitter.com/acme'),
      r('https://x.com/acme'),
      r('https://github.com/acme'),
    ];
    assert.equal(pickDomainFromResults(results), null);
  });

  it('returns null for an empty result set', () => {
    assert.equal(pickDomainFromResults([]), null);
  });

  it('still finds the official domain past a wall of aggregators (top-10 widening)', () => {
    // Cohere-style SERP: five aggregators rank above the real site. With the old
    // top-5 cap this returned null and the company got dropped; we now scan deeper.
    const results = [
      r('https://www.linkedin.com/company/cohere'),
      r('https://www.crunchbase.com/organization/cohere'),
      r('https://en.wikipedia.org/wiki/Cohere'),
      r('https://www.bloomberg.com/profile/company/cohere'),
      r('https://www.glassdoor.com/Overview/cohere'),
      r('https://cohere.com/'),
    ];
    assert.equal(pickDomainFromResults(results), 'cohere.com');
  });
});

describe('guessDomainCandidates', () => {
  it('derives <name>.com/.ai/.io, most-likely first', () => {
    assert.deepEqual(guessDomainCandidates('Cohere'), ['cohere.com', 'cohere.ai', 'cohere.io']);
  });

  it('strips corporate suffixes and keeps a first-word fallback', () => {
    // "Cohere Labs" → cohere.* (suffix dropped); multi-word names also try the
    // joined form plus the first word alone.
    assert.deepEqual(guessDomainCandidates('Cohere Labs'), ['cohere.com', 'cohere.ai', 'cohere.io']);
    const sierra = guessDomainCandidates('Sierra Studio');
    assert.ok(sierra.includes('sierrastudio.com'));
    assert.ok(sierra.includes('sierra.com'));
  });

  it('lowercases and strips spaces/punctuation', () => {
    assert.deepEqual(guessDomainCandidates('Acme, Inc.'), ['acme.com', 'acme.ai', 'acme.io']);
  });

  it('returns nothing for an empty/too-short name', () => {
    assert.deepEqual(guessDomainCandidates(''), []);
    assert.deepEqual(guessDomainCandidates('X'), []);
  });
});

describe('guessDomainByName', () => {
  it('accepts the first candidate that verifies live (never a blind guess)', async () => {
    // Aggregator-only Serper result already fell through to here; the name guess
    // now rescues the company by verifying a derived hostname responds.
    const probed: string[] = [];
    const verify = async (host: string) => {
      probed.push(host);
      return host === 'cohere.com'; // only the .com is "live"
    };
    assert.equal(await guessDomainByName('Cohere', verify), 'cohere.com');
    assert.deepEqual(probed, ['cohere.com']); // stops at first hit, no needless probes
  });

  it('returns null when no candidate responds (stays conservative)', async () => {
    const verify = async () => false;
    assert.equal(await guessDomainByName('Cohere', verify), null);
  });

  it('skips dead candidates and tries the next TLD', async () => {
    const verify = async (host: string) => host === 'cohere.ai';
    assert.equal(await guessDomainByName('Cohere', verify), 'cohere.ai');
  });
});

describe('parseEmployeeCount', () => {
  it('takes the upper bound of a range', () => {
    assert.equal(parseEmployeeCount('Financial Services · 1,001-5,000 employees'), 5000);
  });
  it('reads the floor of an "N+" count', () => {
    assert.equal(parseEmployeeCount('Banking · 10,001+ employees · Toronto'), 10001);
  });
  it('reads a plain count', () => {
    assert.equal(parseEmployeeCount('Startup · 42 employees'), 42);
  });
  it('returns null when there is no headcount', () => {
    assert.equal(parseEmployeeCount('Acme - the official website'), null);
    assert.equal(parseEmployeeCount(''), null);
  });
});
