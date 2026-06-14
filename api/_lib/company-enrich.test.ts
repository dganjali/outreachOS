import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickDomainFromResults, parseEmployeeCount } from './company-enrich';
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
    assert.equal(parseEmployeeCount('Acme — the official website'), null);
    assert.equal(parseEmployeeCount(''), null);
  });
});
