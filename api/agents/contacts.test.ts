import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoolWithBudget, fillWithDisplayOnly, rankCandidates, narrowIcpBySelection, seedToSuggestion, type ResolvePoolDeps, type ContactSuggestion } from './contacts';
import { defaultContactIcp } from '../_lib/icp';
import type { ResolvedEmail } from '../_lib/email-resolver';
import type { ScrapeResult } from '../_lib/web-scrape';
import type { ContactVerification, Verdict } from '../_lib/contact-verify';
import type { ContactDoc, MissionDoc, TargetDoc } from '../../shared/schemas';
import type { ContactIcp } from '../../shared/types';

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
  it('stops at the requested count once enough are reachable', async () => {
    const pool = ['A', 'B', 'C', 'D', 'E', 'F'].map(row);
    const { deps, calls } = depsFor(new Set(['A', 'B', 'C', 'D', 'E', 'F']));
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 3, deps);
    assert.equal(out.rows.length, 3);
    assert.equal(calls(), 3, 'should not resolve beyond the 3 it needs');
    assert.deepEqual(out.rows.map((r) => r.name), ['A', 'B', 'C']);
    assert.ok(out.rows.every((r) => r.email && r.emailResolver === 'verifier'));
    // Telemetry rides along: three verifier hits, no misses.
    assert.equal(out.attempts, 3);
    assert.equal(out.resolverCounts.verifier, 3);
    assert.equal(out.resolverCounts.none, 0);
  });

  it('keeps exactly the requested count (1) while resolving a small speed batch', async () => {
    const pool = ['A', 'B', 'C', 'D'].map(row);
    const { deps, calls } = depsFor(new Set(['A', 'B', 'C', 'D']));
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 1, deps);
    assert.equal(out.rows.length, 1, 'no extra contacts beyond what was asked for');
    assert.equal(calls(), 3, 'looks ahead so one slow/missing candidate does not stall the company');
    assert.deepEqual(out.rows.map((r) => r.name), ['A']);
  });

  it('drops non-deliverable candidates and keeps pulling the next one', async () => {
    // Only D, E, F resolve; the loop must skip A/B/C and still return 3.
    const pool = ['A', 'B', 'C', 'D', 'E', 'F'].map(row);
    const { deps } = depsFor(new Set(['D', 'E', 'F']));
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 3, deps);
    assert.deepEqual(out.rows.map((r) => r.name), ['D', 'E', 'F']);
  });

  it('never attempts more than RESOLVE_ATTEMPT_CAP (15) candidates', async () => {
    const pool = Array.from({ length: 20 }, (_, i) => row(`P${i}`));
    const { deps, calls } = depsFor(new Set()); // nobody resolves
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 3, deps);
    assert.equal(calls(), 15, 'attempt cap bounds finder/verifier spend');
    assert.equal(out.attempts, 15);
  });

  it('returns empty when nothing is deliverable (company gets dropped/replaced)', async () => {
    const pool = ['A', 'B', 'C', 'D', 'E'].map(row);
    const { deps } = depsFor(new Set());
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 3, deps);
    assert.equal(out.rows.length, 0, 'never ships display-only rows with no verified email');
    // Diagnosis: walked the whole (sub-cap) pool, every attempt a finder miss.
    assert.equal(out.attempts, 5);
    assert.equal(out.resolverCounts.none, 5);
  });

  it('returns empty when there is no domain (no resolution possible)', async () => {
    const pool = ['A', 'B', 'C', 'D'].map(row);
    const { deps, calls } = depsFor(new Set(['A', 'B', 'C', 'D']));
    const out = await resolvePoolWithBudget(pool, null, 't1', 3, deps);
    assert.equal(out.rows.length, 0);
    assert.equal(out.attempts, 0);
    assert.equal(calls(), 0, 'no domain → no resolver calls');
  });

  it("drops 'likely' (unverified) addresses and walks on to a verified one", async () => {
    const deps: ResolvePoolDeps = {
      scrape: async () => emptyScrape,
      resolve: async (name, domain): Promise<ResolvedEmail> =>
        name === 'A'
          ? { email: `a@${domain}`, emailStatus: 'likely', likelyEmailPattern: null, resolver: 'verifier' }
          : { email: `${name.toLowerCase()}@${domain}`, emailStatus: 'verified', likelyEmailPattern: null, resolver: 'verifier' },
    };
    const out = await resolvePoolWithBudget(['A', 'B'].map(row), 'acme.co', 't1', 1, deps);
    assert.deepEqual(out.rows.map((r) => r.name), ['B'], 'the likely A is skipped, verified B is kept');
    assert.equal(out.rows[0].emailStatus, 'verified');
  });

  it('returns empty when every reachable address is only likely (not verified)', async () => {
    const deps: ResolvePoolDeps = {
      scrape: async () => emptyScrape,
      resolve: async (name, domain): Promise<ResolvedEmail> => ({
        email: `${name.toLowerCase()}@${domain}`,
        emailStatus: 'likely',
        likelyEmailPattern: null,
        resolver: 'verifier',
      }),
    };
    const out = await resolvePoolWithBudget(['A', 'B', 'C'].map(row), 'acme.co', 't1', 2, deps);
    assert.equal(out.rows.length, 0, 'never ships an unverified address');
  });

  it('resolves a batch concurrently rather than one-at-a-time', async () => {
    // Gate every resolve on a barrier that only releases once the requested count
    // of calls are in flight - this only completes if the walk fans them out.
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const deps: ResolvePoolDeps = {
      scrape: async () => emptyScrape,
      resolve: async (name, domain): Promise<ResolvedEmail> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (inFlight >= 3) release();
        await barrier;
        inFlight--;
        return { email: `${name.toLowerCase()}@${domain}`, emailStatus: 'verified', likelyEmailPattern: null, resolver: 'verifier' };
      },
    };
    const out = await resolvePoolWithBudget(['A', 'B', 'C'].map(row), 'acme.co', 't1', 3, deps);
    assert.equal(out.rows.length, 3);
    assert.equal(maxInFlight, 3, 'the three needed candidates resolve in parallel');
  });
});

// A resolver where everyone is deliverable, plus a verify dep driven by a
// name→verdict map (anyone unlisted defaults to 'match'). Counts verify calls so
// we can assert it only runs on reachable people.
function depsWithVerify(verdicts: Record<string, Verdict>): { deps: ResolvePoolDeps; verifyCalls: () => number } {
  let verifyCalls = 0;
  const deps: ResolvePoolDeps = {
    scrape: async () => emptyScrape,
    resolve: async (name, domain): Promise<ResolvedEmail> => ({
      email: `${name.toLowerCase()}@${domain}`,
      emailStatus: 'verified',
      likelyEmailPattern: null,
      resolver: 'verifier',
    }),
    verify: async (row): Promise<ContactVerification> => {
      verifyCalls++;
      const verdict = verdicts[row.name] ?? 'match';
      return {
        verdict,
        confidence: verdict === 'match' ? 0.9 : 0.2,
        reason: `${row.name} is a ${verdict}`,
        research: verdict === 'mismatch' ? [] : [{ fact: `${row.name} ships things`, sourceUrl: 'https://x.co', sourceTitle: 'X' }],
      };
    },
  };
  return { deps, verifyCalls: () => verifyCalls };
}

describe('resolvePoolWithBudget - recipient verification gate', () => {
  it('drops a mismatch and pulls the next candidate', async () => {
    const pool = ['A', 'B', 'C'].map(row);
    const { deps } = depsWithVerify({ A: 'mismatch', B: 'match' });
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 1, deps);
    assert.deepEqual(out.rows.map((r) => r.name), ['B'], 'A is rejected, B is kept');
    assert.equal(out.verifiedDropped, 1);
  });

  it('returns empty (company dropped/replaced) when everyone reachable is a mismatch', async () => {
    const pool = ['A', 'B', 'C'].map(row);
    const { deps } = depsWithVerify({ A: 'mismatch', B: 'mismatch', C: 'mismatch' });
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 1, deps);
    assert.equal(out.rows.length, 0);
    assert.equal(out.verifiedDropped, 3);
  });

  it('keeps weak verdicts (only clear mismatches are dropped)', async () => {
    const pool = ['A'].map(row);
    const { deps } = depsWithVerify({ A: 'weak' });
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 1, deps);
    assert.deepEqual(out.rows.map((r) => r.name), ['A']);
    assert.equal(out.rows[0].verification?.verdict, 'weak');
  });

  it('annotates kept rows with the verdict and person research', async () => {
    const pool = ['A'].map(row);
    const { deps } = depsWithVerify({ A: 'match' });
    const out = await resolvePoolWithBudget(pool, 'acme.co', 't1', 1, deps);
    const kept = out.rows[0];
    assert.equal(kept.verification?.verdict, 'match');
    assert.ok((kept.verification?.confidence ?? 0) > 0.5);
    assert.ok(kept.verification?.checkedAt instanceof Date);
    assert.equal(kept.personResearch?.[0].fact, 'A ships things');
  });

  it('only verifies people who resolved an email', async () => {
    // A and C resolve, B does not; verify must run on A and C only.
    let verifyCalls = 0;
    const deps: ResolvePoolDeps = {
      scrape: async () => emptyScrape,
      resolve: async (name, domain): Promise<ResolvedEmail> =>
        name === 'B'
          ? { email: null, emailStatus: 'none', likelyEmailPattern: null, resolver: 'none' }
          : { email: `${name}@${domain}`, emailStatus: 'verified', likelyEmailPattern: null, resolver: 'verifier' },
      verify: async (): Promise<ContactVerification> => {
        verifyCalls++;
        return { verdict: 'match', confidence: 0.9, reason: 'ok', research: [] };
      },
    };
    const out = await resolvePoolWithBudget(['A', 'B', 'C'].map(row), 'acme.co', 't1', 2, deps);
    assert.deepEqual(out.rows.map((r) => r.name), ['A', 'C']);
    assert.equal(verifyCalls, 2, 'unreachable B is never verified');
  });

  it('no verify dep ⇒ unchanged behavior, verifiedDropped is 0', async () => {
    const { deps } = depsFor(new Set(['A', 'B']));
    const out = await resolvePoolWithBudget(['A', 'B'].map(row), 'acme.co', 't1', 2, deps);
    assert.deepEqual(out.rows.map((r) => r.name), ['A', 'B']);
    assert.equal(out.verifiedDropped, 0);
    assert.equal(out.rows[0].verification, undefined);
  });
});

describe('fillWithDisplayOnly - surface people even when no email verifies', () => {
  const withEmail = (name: string): ContactRow => ({ ...row(name), email: `${name}@acme.co`, emailStatus: 'verified' });

  it('returns the resolved rows unchanged when they already fill the ask', () => {
    const resolved = [withEmail('A')];
    const out = fillWithDisplayOnly(resolved, [row('A'), row('B')], 1);
    assert.deepEqual(out.map((r) => r.name), ['A']);
    assert.equal(out.every((r) => !!r.email), true, 'no email-less rows added when not needed');
  });

  it('backfills the best email-less people when nothing verified', () => {
    // Discovery found B and C but no address could be verified for either.
    const out = fillWithDisplayOnly([], [row('B'), row('C')], 1);
    assert.deepEqual(out.map((r) => r.name), ['B'], 'best-ranked person surfaces');
    assert.equal(out[0].email, null);
    assert.equal(out[0].emailStatus, 'none');
  });

  it('puts verified-email rows first, then tops up with display-only', () => {
    const out = fillWithDisplayOnly([withEmail('A')], [row('A'), row('B'), row('C')], 3);
    assert.deepEqual(out.map((r) => r.name), ['A', 'B', 'C']);
    assert.equal(!!out[0].email, true);
    assert.equal(out[1].email, null);
  });

  it('dedupes a resolved row against its source candidate', () => {
    // A appears both resolved (with email) and in the ranked pool - keep one A.
    const out = fillWithDisplayOnly([withEmail('A')], [row('A'), row('B')], 3);
    assert.deepEqual(out.map((r) => r.name), ['A', 'B']);
  });

  it('returns empty only when discovery found nobody', () => {
    assert.equal(fillWithDisplayOnly([], [], 1).length, 0);
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

describe('narrowIcpBySelection - user-chosen contact types narrow the ICP', () => {
  const icp: ContactIcp = {
    ...defaultContactIcp('sponsorship'),
    functions: ['community', 'sponsorships', 'partnerships'],
    functionKeywords: ['community', 'sponsorship', 'partnerships'],
    seniority: { idealLevels: ['manager', 'senior_manager', 'director'], maxLevel: 'director' },
  };

  it('no filter ⇒ unchanged ICP (AI-only default)', () => {
    assert.deepEqual(narrowIcpBySelection(icp, undefined), icp);
  });

  it('empty selection ⇒ keeps the full ICP (back-compat)', () => {
    const out = narrowIcpBySelection(icp, { functions: [], seniority: [] });
    assert.deepEqual(out.functions, icp.functions);
    assert.deepEqual(out.seniority.idealLevels, icp.seniority.idealLevels);
  });

  it('keeps only the chosen functions and levels (case-insensitive)', () => {
    const out = narrowIcpBySelection(icp, { functions: ['Community'], seniority: ['director'] });
    assert.deepEqual(out.functions, ['community']);
    assert.deepEqual(out.seniority.idealLevels, ['director']);
  });

  it('never raises maxLevel (the size-relative cap is untouched)', () => {
    const out = narrowIcpBySelection(icp, { functions: ['community'], seniority: ['manager'] });
    assert.equal(out.seniority.maxLevel, 'director');
  });

  it('a selection that intersects to empty falls back to the full set', () => {
    const out = narrowIcpBySelection(icp, { functions: ['nonexistent'], seniority: [] });
    assert.deepEqual(out.functions, icp.functions, 'never produces a zero-function ICP');
  });

  it('drops invalid seniority values rather than trusting them', () => {
    const out = narrowIcpBySelection(icp, { seniority: ['director', 'galaxy_emperor' as never] });
    assert.deepEqual(out.seniority.idealLevels, ['director']);
  });

  it('narrowing functions still finds the right people end-to-end', () => {
    const narrowed = narrowIcpBySelection(icp, { functions: ['community'], seniority: ['manager', 'senior_manager'] });
    const suggestions = [
      suggestion('Manny Mgr', 'Senior Community Investment Manager'),
      suggestion('Pat Partner', 'Partnerships Manager'),
    ];
    const result = rankCandidates(suggestions, { icp: narrowed, sizeTier: 'enterprise', target, mission, profile: null });
    // the partnerships person is now off-function and ranks below the community manager
    assert.equal(result.rows[0].name, 'Manny Mgr');
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

// ---------------------------------------------------------------------------
// People mode: a target seeded with a specific person skips fresh discovery and
// runs that ONE person through the same rank → resolve pipeline.
// ---------------------------------------------------------------------------
describe('seedToSuggestion - people mode seeds the contact pipeline', () => {
  const seed = {
    name: 'Ada Investor',
    role: 'General Partner',
    linkedinUrl: 'https://linkedin.com/in/adainvestor',
    location: 'Toronto, CA',
    headline: 'Backing dev-tools founders',
    confidence: 0.82,
  };

  it('maps the seeded person onto a discovery candidate', () => {
    const s = seedToSuggestion(seed);
    assert.equal(s.name, 'Ada Investor');
    assert.equal(s.role, 'General Partner');
    assert.equal(s.linkedin_url, 'https://linkedin.com/in/adainvestor');
    assert.equal(s.email, null); // resolution happens downstream
    assert.equal(s.confidence, 0.82);
  });

  it('the seeded person survives ranking even when above the seniority cap', () => {
    // A General Partner parses as "founder" (rank 11) - above an enterprise bd
    // cap. People mode must NOT drop the very person we set out to reach: the
    // fallback re-scores with allowAboveCap and keeps them.
    const icp = defaultContactIcp('bd');
    const result = rankCandidates([seedToSuggestion(seed)], {
      icp,
      sizeTier: 'enterprise',
      target,
      mission,
      profile: null,
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].name, 'Ada Investor');
  });
});
