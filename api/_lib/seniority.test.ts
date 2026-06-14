import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeniority,
  sizeTierFromCount,
  effectiveBand,
  matchFunctions,
  geoFitScore,
  scoreContact,
  rank,
  SENIORITY_RANK,
} from './seniority';
import type { ContactIcp } from '../../shared/types';

// A community-investment / sponsorship-style ICP, the scenario behind the
// reported "too high up" miss.
const COMMUNITY_ICP: ContactIcp = {
  functions: ['community investment', 'corporate citizenship', 'community', 'sponsorship'],
  functionKeywords: ['community', 'investment', 'citizenship', 'sponsorship'],
  seniority: { idealLevels: ['manager', 'senior_manager', 'director'], maxLevel: 'director' },
  disqualifierKeywords: ['former', 'retired', 'intern'],
  routerOk: true,
  geo: { preferred: null, scope: 'global', strict: false },
  rationale: 'program owners reply',
};

describe('parseSeniority', () => {
  const cases: Array<[string, string]> = [
    ['Regional President', 'founder'],
    ['Global Chief Marketing Officer', 'cxo'],
    ['Senior Vice President, Community', 'svp'],
    ['VP of Partnerships', 'vp'],
    ['Senior Director, Global Design and Standards', 'senior_director'],
    ['Director, Sponsors and Community Investment', 'director'],
    ['Head of Community', 'director'],
    ['Senior Community Investment Manager', 'senior_manager'],
    ['Community Investment Manager', 'manager'],
    ['Developer Relations Lead', 'lead'],
    ['Principal Engineer', 'senior_ic'],
    ['Senior Software Engineer', 'senior_ic'],
    ['Software Engineer', 'ic'],
    ['Community Coordinator', 'ic'],
  ];
  for (const [title, expected] of cases) {
    it(`${title} → ${expected}`, () => {
      assert.equal(parseSeniority(title).level, expected);
    });
  }

  it('does not mistake "Vice President" for president/founder', () => {
    assert.equal(parseSeniority('Vice President, Sales').level, 'vp');
  });

  it('flags routers and scope qualifiers', () => {
    const ea = parseSeniority('Executive Assistant to the CEO');
    assert.equal(ea.isRouter, true);
    assert.equal(parseSeniority('Global Head of Community').scope, 'global');
    assert.equal(parseSeniority('Regional Manager').scope, 'regional');
  });

  it('returns unknown (rank 0) for empty/garbage', () => {
    assert.deepEqual(parseSeniority('').level, null);
    assert.equal(parseSeniority('').rank, 0);
  });
});

describe('sizeTierFromCount', () => {
  it('buckets headcount', () => {
    assert.equal(sizeTierFromCount(20), 'startup');
    assert.equal(sizeTierFromCount(120), 'small');
    assert.equal(sizeTierFromCount(900), 'mid');
    assert.equal(sizeTierFromCount(5000), 'large');
    assert.equal(sizeTierFromCount(80000), 'enterprise');
    assert.equal(sizeTierFromCount(null), null);
    assert.equal(sizeTierFromCount(0), null);
  });
});

describe('effectiveBand', () => {
  it('drops the cap as the company grows', () => {
    const startup = effectiveBand(COMMUNITY_ICP, 'startup');
    const enterprise = effectiveBand(COMMUNITY_ICP, 'enterprise');
    assert.ok(enterprise.hardMax < startup.hardMax || enterprise.hardMax <= rank('director'));
    assert.equal(enterprise.hardMax, rank('director'));
  });
  it('never lets the ICP exceed the size cap', () => {
    const wideIcp: ContactIcp = { ...COMMUNITY_ICP, seniority: { idealLevels: ['director', 'vp'], maxLevel: 'cxo' } };
    const band = effectiveBand(wideIcp, 'enterprise');
    assert.ok(band.hardMax <= rank('director'));
  });
});

describe('matchFunctions & geoFitScore', () => {
  it('matches by phrase or distinctive word', () => {
    assert.deepEqual(matchFunctions('Community Investment Manager', ['community investment']), ['community investment']);
    assert.ok(matchFunctions('Head of Corporate Citizenship', ['corporate citizenship']).length === 1);
    assert.equal(matchFunctions('VP of Sales', ['community investment']).length, 0);
  });
  it('scores geo fit', () => {
    const geo = { preferred: 'Toronto, CA', scope: 'country' as const, strict: false };
    assert.equal(geoFitScore('Toronto, Ontario, Canada', geo), 1);
    assert.equal(geoFitScore('London, UK', geo), 0.45);
    assert.equal(geoFitScore(null, geo), 0.6);
    assert.equal(geoFitScore('anywhere', { preferred: null, scope: 'global', strict: false }), 1);
  });
});

// The headline scenario: at an enterprise these are the actual reported titles.
describe('scoreContact — the bank example at enterprise size', () => {
  const score = (title: string) => scoreContact({ title, icp: COMMUNITY_ICP, sizeTier: 'enterprise' });

  it('drops the off-function execs (too high up)', () => {
    assert.equal(score('Regional President').disqualified, true);
    assert.equal(score('Global Chief Marketing Officer').disqualified, true);
    assert.equal(score('Senior Director, Global Design and Standards').disqualified, true);
  });

  it('keeps the program owners and ranks them on top', () => {
    const mgr = score('Senior Community Investment Manager');
    const dir = score('Director, Sponsors and Community Investment');
    assert.equal(mgr.disqualified, false);
    assert.equal(dir.disqualified, false);
    assert.ok(mgr.score > 0.6);
    assert.ok(dir.score > 0.6);
  });

  it('keeps an on-function senior exec as a down-ranked fallback (not dropped)', () => {
    const svp = score('Senior Vice President, Community');
    assert.equal(svp.disqualified, false, 'on-function SVP survives');
    const mgr = score('Senior Community Investment Manager');
    assert.ok(mgr.score > svp.score, 'but the manager outranks the SVP');
  });

  it('full ranking puts owners first, exec fallback last, execs gone', () => {
    const titles = [
      'Regional President',
      'Global Chief Marketing Officer',
      'Senior Vice President, Community',
      'Director, Sponsors and Community Investment',
      'Senior Community Investment Manager',
    ];
    const ranked = titles
      .map((t) => ({ t, s: score(t) }))
      .filter((x) => !x.s.disqualified)
      .sort((a, b) => b.s.score - a.s.score)
      .map((x) => x.t);
    assert.deepEqual(ranked, [
      'Senior Community Investment Manager',
      'Director, Sponsors and Community Investment',
      'Senior Vice President, Community',
    ]);
  });
});

describe('scoreContact — size relativity', () => {
  it('keeps the founder/CEO at a startup but not at an enterprise', () => {
    // ICP that genuinely allows execs (maxLevel cxo) so the SIZE band — not the
    // ICP cap — is what differentiates the two cases.
    const icp: ContactIcp = {
      ...COMMUNITY_ICP,
      functions: ['marketing', 'brand'],
      seniority: { idealLevels: ['director', 'vp'], maxLevel: 'cxo' },
    };
    const startup = scoreContact({ title: 'Chief Marketing Officer', icp, sizeTier: 'startup' });
    const enterprise = scoreContact({ title: 'Chief Marketing Officer', icp, sizeTier: 'enterprise' });
    assert.equal(startup.disqualified, false, 'CMO is in-cap at a startup');
    assert.ok(startup.score > 0.5);
    // At an enterprise the CMO is above the size cap → on-function fallback only.
    assert.ok(enterprise.score < startup.score, 'enterprise CMO ranks below startup CMO');
  });
});

describe('SENIORITY_RANK monotonicity', () => {
  it('is strictly increasing junior→senior', () => {
    const order = ['ic', 'senior_ic', 'lead', 'manager', 'senior_manager', 'director', 'senior_director', 'vp', 'svp', 'cxo', 'founder'] as const;
    for (let i = 1; i < order.length; i++) {
      assert.ok(SENIORITY_RANK[order[i]] > SENIORITY_RANK[order[i - 1]]);
    }
  });
});
