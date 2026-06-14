import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoolWithBudget, rankCandidates, type ResolvePoolDeps, type ContactSuggestion } from './contacts';
import { defaultContactIcp } from '../_lib/icp';
import type { ResolvedEmail } from '../_lib/email-resolver';
import type { ScrapeResult } from '../_lib/web-scrape';
import type { ContactDoc, MissionDoc, TargetDoc } from '../../shared/schemas';

type ContactRow = Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>;

function row(name: string): ContactRow {
  return {
    targetId: 't1',
    missionId: 'm1',
    name,
    role: 'Head of Stuff',
    email: null,
    emailStatus: 'none',
    linkedinUrl: null,
    likelyEmailPattern: null,
    confidence: 0.7,
    reasoning: 'ranked',
    status: 'suggested',
    source: 'web_search',
    seniority: null,
    headline: null,
    location: null,
  };
}

const emptyScrape: ScrapeResult = { domain: 'acme.co', emails: [], pattern: null, pagesScraped: [] };

// Build deps whose resolver returns a deliverable email for the named people and
// 'none' for everyone else, while counting how many times it was called.
function depsFor(deliverable: Set<string>): { deps: ResolvePoolDeps; calls: () => number } {
  let calls = 0;
  const deps: ResolvePoolDeps = {
    scrape: async () => emptyScrape,
    resolve: async (name, domain): Promise<ResolvedEmail> => {
      calls++;
      if (deliverable.has(name)) {
        return { email: `${name.toLowerCase()}@${domain}`, emailStatus: 'verified', likelyEmailPattern: null, resolver: 'verifier' };
      }
      return { email: null, emailStatus: 'none', likelyEmailPattern: null, resolver: 'none' };
    },
  };
  return { deps, calls: () => calls };
}

describe('resolvePoolWithBudget', () => {
  it('stops at TARGET_DELIVERABLE (3) once enough are reachable', async () => {
    const pool = ['A', 'B', 'C', 'D', 'E', 'F'].map(row);
    const { deps, calls } = depsFor(new Set(['A', 'B', 'C', 'D', 'E', 'F']));
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', deps);
    assert.equal(out.length, 3);
    assert.equal(calls(), 3, 'should not resolve beyond the 3 it needs');
    assert.deepEqual(out.map((r) => r.name), ['A', 'B', 'C']);
    assert.ok(out.every((r) => r.email && r.emailResolver === 'verifier'));
  });

  it('drops non-deliverable candidates and keeps pulling the next one', async () => {
    // Only D, E, F resolve; the loop must skip A/B/C and still return 3.
    const pool = ['A', 'B', 'C', 'D', 'E', 'F'].map(row);
    const { deps } = depsFor(new Set(['D', 'E', 'F']));
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', deps);
    assert.deepEqual(out.map((r) => r.name), ['D', 'E', 'F']);
  });

  it('never attempts more than RESOLVE_ATTEMPT_CAP (8) candidates', async () => {
    const pool = Array.from({ length: 10 }, (_, i) => row(`P${i}`));
    const { deps, calls } = depsFor(new Set()); // nobody resolves
    await resolvePoolWithBudget(pool, 'acme.co', 't1', deps);
    assert.equal(calls(), 8, 'attempt cap bounds finder/verifier spend');
  });

  it('falls back to top-ranked display-only rows when nothing is deliverable', async () => {
    const pool = ['A', 'B', 'C', 'D', 'E'].map(row);
    const { deps } = depsFor(new Set());
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', deps);
    assert.equal(out.length, 3, 'ships top-3 so a target is never empty');
    assert.deepEqual(out.map((r) => r.name), ['A', 'B', 'C']);
    assert.ok(out.every((r) => r.email === null && r.emailResolver === 'none'));
  });

  it('returns display-only rows when there is no domain (no resolution possible)', async () => {
    const pool = ['A', 'B', 'C', 'D'].map(row);
    const { deps, calls } = depsFor(new Set(['A', 'B', 'C', 'D']));
    const out = await resolvePoolWithBudget(pool, null, 't1', deps);
    assert.equal(out.length, 3);
    assert.equal(calls(), 0, 'no domain → no resolver calls');
    assert.ok(out.every((r) => r.emailResolver === 'none'));
  });
});

// ---------------------------------------------------------------------------
// rankCandidates - the end-to-end "right people" behavior on the reported bank
// example: drop the off-function execs, keep the program owners, sort by
// reply-likelihood, populate seniority.
// ---------------------------------------------------------------------------

function suggestion(name: string, role: string): ContactSuggestion {
  return {
    name,
    role,
    linkedin_url: `https://linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '')}`,
    location: null,
    headline: null,
    email: null,
    likely_email_pattern: null,
    confidence: 0.7,
    reasoning: 'serp',
  };
}

const target = { _id: 't1', companyName: 'Big Bank' } as TargetDoc;
const mission = { _id: 'm1', mode: 'sponsorship' } as MissionDoc;

describe('rankCandidates - the bank example at enterprise size', () => {
  // A community-investment-flavored sponsorship ICP.
  const icp = {
    ...defaultContactIcp('sponsorship'),
    functions: ['community investment', 'community', 'sponsorship', 'corporate citizenship'],
    functionKeywords: ['community', 'investment', 'sponsorship'],
  };

  const suggestions = [
    suggestion('Reggie Prez', 'Regional President'),
    suggestion('Glenda Cmo', 'Global Chief Marketing Officer'),
    suggestion('Dana Design', 'Senior Director, Global Design and Standards'),
    suggestion('Sam Svp', 'Senior Vice President, Community'),
    suggestion('Dina Dir', 'Director, Sponsors and Community Investment'),
    suggestion('Manny Mgr', 'Senior Community Investment Manager'),
  ];

  const result = rankCandidates(suggestions, { icp, sizeTier: 'enterprise', target, mission, profile: null });
  const names = result.rows.map((r) => r.name);

  it('drops the off-function execs (president, CMO, design director)', () => {
    assert.ok(!names.includes('Reggie Prez'));
    assert.ok(!names.includes('Glenda Cmo'));
    assert.ok(!names.includes('Dana Design'));
    assert.equal(result.droppedAboveCap, 3);
  });

  it('ranks the program owners on top, exec fallback last', () => {
    assert.deepEqual(names, ['Manny Mgr', 'Dina Dir', 'Sam Svp']);
  });

  it('populates the parsed seniority level and uses score as confidence', () => {
    const mgr = result.rows.find((r) => r.name === 'Manny Mgr')!;
    assert.equal(mgr.seniority, 'senior_manager');
    assert.ok((mgr.confidence ?? 0) > 0.6);
    // ordering is by confidence (= composite reply-likelihood score)
    const confs = result.rows.map((r) => r.confidence ?? 0);
    assert.deepEqual(confs, [...confs].sort((a, b) => b - a));
  });
});

describe('rankCandidates - never returns an empty target', () => {
  const icp = defaultContactIcp('bd'); // partnerships, caps at director
  it('falls back to above-cap people when the band disqualifies everyone', () => {
    // Off-function AND above-cap → disqualified in the strict pass; the fallback
    // re-scores with allowAboveCap so the target still gets best-available rows.
    const onlyExecs = [suggestion('Fin Vp', 'VP of Finance'), suggestion('Fin Cfo', 'Chief Financial Officer')];
    const strict = rankCandidates(onlyExecs, { icp, sizeTier: 'enterprise', target, mission, profile: null });
    assert.ok(strict.rows.length > 0, 'surfaces best-available instead of nothing');
    assert.equal(strict.usedFallback, true);
  });

  it('on-function above-cap people are kept WITHOUT needing the fallback', () => {
    const onFn = [suggestion('V P', 'VP, Strategic Partnerships')];
    const result = rankCandidates(onFn, { icp, sizeTier: 'enterprise', target, mission, profile: null });
    assert.equal(result.rows.length, 1);
    assert.equal(result.usedFallback, false);
  });
});
