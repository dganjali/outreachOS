import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrganic, buildPeopleQuery, buildPeopleQueries, profileKey, search, parseLinkedinTitle, seededRotate } from './serper';

describe('parseOrganic', () => {
  it('extracts title/link/snippet from organic results', () => {
    const raw = {
      organic: [
        { title: 'Jane Doe - Head of DevRel - Acme | LinkedIn', link: 'https://linkedin.com/in/janedoe', snippet: 'Acme · Head of DevRel' },
        { title: 'No link entry', snippet: 'dropped because no link' },
      ],
    };
    const out = parseOrganic(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].link, 'https://linkedin.com/in/janedoe');
    assert.equal(out[0].title, 'Jane Doe - Head of DevRel - Acme | LinkedIn');
  });

  it('returns [] for missing or malformed bodies', () => {
    assert.deepEqual(parseOrganic(null), []);
    assert.deepEqual(parseOrganic({}), []);
    assert.deepEqual(parseOrganic({ organic: 'nope' }), []);
    assert.deepEqual(parseOrganic({ organic: [null, 42] }), []);
  });
});

describe('buildPeopleQuery', () => {
  it('scopes to linkedin.com/in with OR-joined titles and the company', () => {
    const q = buildPeopleQuery('Acme', ['developer relations', 'partnerships']);
    assert.equal(q, 'site:linkedin.com/in ("developer relations" OR "partnerships") "Acme"');
  });

  it('omits the title clause when there are no hints', () => {
    assert.equal(buildPeopleQuery('Acme', []), 'site:linkedin.com/in "Acme"');
  });

  it('caps the number of title hints at 6', () => {
    const q = buildPeopleQuery('Acme', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    assert.ok(!q.includes('"g"'));
    assert.ok(q.includes('"f"'));
  });
});

describe('buildPeopleQueries (ICP-driven)', () => {
  it('emits a precise query (function × seniority + negatives) and a broad net', () => {
    const qs = buildPeopleQueries({
      companyName: 'RBC',
      functionKeywords: ['community investment', 'corporate citizenship'],
      seniorityKeywords: ['manager', 'director'],
      negativeTerms: ['president', 'chief', 'vp'],
    });
    // precise query has functions, seniority, negatives
    assert.ok(qs[0].includes('"community investment"'));
    assert.ok(qs[0].includes('"manager"'));
    assert.ok(qs[0].includes('-president'));
    // broad net keeps functions but NOT the seniority constraint or negatives
    const broad = qs.find((q) => !q.includes('-president'));
    assert.ok(broad, 'a negatives-free broad query exists');
    assert.ok(broad!.includes('"community investment"'));
    assert.ok(!broad!.includes('"manager"'));
  });

  it('adds a geo variant only when geo is set', () => {
    const without = buildPeopleQueries({ companyName: 'Acme', functionKeywords: ['community'] });
    const withGeo = buildPeopleQueries({ companyName: 'Acme', functionKeywords: ['community'], geo: 'Toronto' });
    assert.ok(!without.some((q) => q.includes('"Toronto"')));
    assert.ok(withGeo.some((q) => q.includes('"Toronto"')));
  });
});

describe('profileKey', () => {
  it('normalizes LinkedIn profile URLs so dupes collapse', () => {
    assert.equal(
      profileKey('https://www.linkedin.com/in/janedoe/'),
      profileKey('https://linkedin.com/in/janedoe')
    );
    assert.notEqual(profileKey('https://linkedin.com/in/jane'), profileKey('https://linkedin.com/in/john'));
  });
});

describe('parseLinkedinTitle', () => {
  it('parses the canonical "Name - Title - Company | LinkedIn" shape', () => {
    const p = parseLinkedinTitle('Manny Okafor - Senior Community Investment Manager - Big Bank | LinkedIn');
    assert.equal(p.name, 'Manny Okafor');
    assert.equal(p.role, 'Senior Community Investment Manager');
    assert.equal(p.company, 'Big Bank');
  });

  it('splits "Role at Company" in a two-part title', () => {
    const p = parseLinkedinTitle('Jane Doe - Director, Sponsorships at Shopify | LinkedIn');
    assert.equal(p.name, 'Jane Doe');
    assert.equal(p.role, 'Director, Sponsorships');
    assert.equal(p.company, 'Shopify');
  });

  it('keeps the role when the title is truncated (no company segment)', () => {
    const p = parseLinkedinTitle('Manny Okafor - Senior Community Investment Manager');
    assert.equal(p.role, 'Senior Community Investment Manager');
  });

  it('treats a bare second segment as a company, not a role', () => {
    const p = parseLinkedinTitle('Bob Lee - Shopify | LinkedIn');
    assert.equal(p.role, null);
    assert.equal(p.company, 'Shopify');
  });

  it('strips trailing "· Experience" noise Google appends', () => {
    const p = parseLinkedinTitle('Ada Lin - Community Manager - Acme · Experience: Acme · 500+ connections');
    assert.equal(p.name, 'Ada Lin');
    assert.equal(p.role, 'Community Manager');
  });

  it('returns nulls for unparseable input', () => {
    assert.deepEqual(parseLinkedinTitle(''), { name: null, role: null, company: null });
  });
});

describe('seededRotate + seeded query rotation', () => {
  it('is the identity for seed 0 / undefined', () => {
    const arr = ['a', 'b', 'c'];
    assert.deepEqual(seededRotate(arr, 0), arr);
    assert.deepEqual(seededRotate(arr, undefined), arr);
  });

  it('rotates by the seed so different seeds pick different leading terms', () => {
    const arr = ['a', 'b', 'c', 'd'];
    assert.deepEqual(seededRotate(arr, 1), ['b', 'c', 'd', 'a']);
    assert.deepEqual(seededRotate(arr, 2), ['c', 'd', 'a', 'b']);
  });

  it('produces the same un-seeded query when no seed is passed', () => {
    const spec = { companyName: 'Acme', functionKeywords: ['community', 'devrel'], seniorityKeywords: ['manager'] };
    assert.deepEqual(buildPeopleQueries(spec), buildPeopleQueries(spec, 0));
  });

  it('rotates the synonym subset when more keywords exist than fit the query', () => {
    const spec = {
      companyName: 'Acme',
      functionKeywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], // 7 > the 6 slice cap
      seniorityKeywords: ['manager'],
    };
    assert.notDeepEqual(buildPeopleQueries(spec, 1), buildPeopleQueries(spec, 3));
  });
});

// Live test - only runs with a real key.
test('live: search returns an organic result array', {
  skip: !process.env.SERPER_API_KEY,
}, async () => {
  const out = await search('site:linkedin.com/in "Stripe"', 3);
  assert.ok(Array.isArray(out));
});
