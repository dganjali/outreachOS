import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrganic, buildPeopleQuery, buildPeopleQueries, profileKey, search } from './serper';

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

// Live test - only runs with a real key.
test('live: search returns an organic result array', {
  skip: !process.env.SERPER_API_KEY,
}, async () => {
  const out = await search('site:linkedin.com/in "Stripe"', 3);
  assert.ok(Array.isArray(out));
});
