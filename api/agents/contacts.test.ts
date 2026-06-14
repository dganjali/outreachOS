import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePoolWithBudget, type ResolvePoolDeps } from './contacts';
import type { ResolvedEmail } from '../_lib/email-resolver';
import type { ScrapeResult } from '../_lib/web-scrape';
import type { ContactDoc } from '../../shared/schemas';

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
