import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { agentRunAnalytics } from './runs';
import type { UserScope } from './db';

// A fake scope whose agent_runs.aggregate() returns a canned $facet result, so
// we exercise the Node-side shaping (percentiles, gap-fill, success rate)
// without a Mongo. `capture` records the pipeline so we can assert the window.
function fakeScope(facet: unknown, capture?: (p: unknown[]) => void): UserScope {
  return {
    uid: 'u1',
    collection() {
      return {
        async aggregate(pipeline: unknown[]) {
          capture?.(pipeline);
          return [facet];
        },
      } as never;
    },
  } as unknown as UserScope;
}

describe('agentRunAnalytics', () => {
  it('shapes per-type stats: avg, p95, and success rate over settled runs', async () => {
    const data = await agentRunAnalytics(
      fakeScope({
        byType: [
          {
            _id: 'draft',
            runs: 5,
            completed: 3,
            failed: 1,
            running: 1,
            // running rows contribute a null duration that must be ignored.
            durations: [100, 200, 300, null],
          },
        ],
        byDay: [],
      }),
      7,
    );

    assert.equal(data.byType.length, 1);
    const t = data.byType[0];
    assert.equal(t.agentType, 'draft');
    assert.equal(t.avgMs, 200); // mean of 100,200,300
    assert.equal(t.p95Ms, 300); // nearest-rank p95
    assert.equal(t.successRate, 0.75); // 3 completed / (3 + 1) settled — running excluded
  });

  it('rolls totals up across types and computes overall latency', async () => {
    const data = await agentRunAnalytics(
      fakeScope({
        byType: [
          { _id: 'draft', runs: 2, completed: 2, failed: 0, running: 0, durations: [100, 300] },
          { _id: 'evidence', runs: 2, completed: 1, failed: 1, running: 0, durations: [500] },
        ],
        byDay: [],
      }),
      30,
    );

    assert.equal(data.totals.runs, 4);
    assert.equal(data.totals.completed, 3);
    assert.equal(data.totals.failed, 1);
    assert.equal(data.totals.successRate, 0.75);
    assert.equal(data.totals.p50Ms, 300); // sorted [100,300,500] → nearest-rank p50
    // Busiest-first ordering by run count (tie broken by input order).
    assert.equal(data.byType[0].runs, 2);
  });

  it('gap-fills the daily series across the whole window', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const data = await agentRunAnalytics(
      fakeScope({
        byType: [],
        byDay: [{ _id: today, runs: 4, completed: 4, failed: 0 }],
      }),
      7,
    );

    // 7-day window → at least 7 contiguous day buckets, ascending, no gaps.
    assert.ok(data.byDay.length >= 7);
    const last = data.byDay[data.byDay.length - 1];
    assert.equal(last.day, today);
    assert.equal(last.runs, 4);
    // A day with no runs is present and zeroed, not missing.
    assert.equal(data.byDay[0].runs, 0);
  });

  it('clamps the window to the 30-day TTL and matches startedAt against it', async () => {
    let seen: unknown[] = [];
    const data = await agentRunAnalytics(fakeScope({ byType: [], byDay: [] }, (p) => (seen = p), ), 999);
    assert.equal(data.windowDays, 30);
    // First stage filters by startedAt >= since.
    const match = seen[0] as { $match?: { startedAt?: { $gte?: Date } } };
    assert.ok(match.$match?.startedAt?.$gte instanceof Date);
  });
});
