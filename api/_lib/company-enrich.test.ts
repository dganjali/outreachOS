import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickDomainFromResults } from './company-enrich';
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
});
