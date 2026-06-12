// Unit tests for the pipeline reducer (advancePipeline). These exercise the
// durable state machine directly with fake executors — no Mongo, no network —
// covering the happy path, partial failures, and the daily-limit pause that the
// browser orchestration used to handle ad hoc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advancePipeline,
  PipelineDailyLimitError,
  PipelineRateLimitError,
  type PipelineExecutors,
} from './pipeline';
import type { PipelineRunDoc } from '../../shared/schemas';

function baseRun(over: Partial<PipelineRunDoc> = {}): PipelineRunDoc {
  const now = new Date();
  return {
    _id: 'run1',
    userId: 'u1',
    createdAt: now,
    updatedAt: now,
    missionId: 'm1',
    status: 'pending',
    phase: 'targeting',
    config: { targetCount: 8, topN: 3 },
    targets: [],
    cursor: null,
    note: null,
    error: null,
    heartbeatAt: now,
    startedAt: now,
    completedAt: null,
    ...over,
  };
}

function fakeExec(over: Partial<PipelineExecutors> = {}): PipelineExecutors {
  return {
    targeting: async () => [
      { id: 't1', name: 'Acme', score: 0.9 },
      { id: 't2', name: 'Globex', score: 0.5 },
    ],
    evidence: async () => undefined,
    contacts: async () => [{ id: 'c1', confidence: 0.8 }],
    sequence: async () => undefined,
    ...over,
  };
}

// Drive a run to a terminal state, mirroring the production loop but synchronous.
async function runToEnd(run: PipelineRunDoc, exec: PipelineExecutors): Promise<PipelineRunDoc> {
  let cur = run;
  for (let i = 0; i < 200; i++) {
    if (['done', 'error', 'paused', 'canceled'].includes(cur.status)) return cur;
    try {
      cur = await advancePipeline(cur, exec);
    } catch (e) {
      if (e instanceof PipelineRateLimitError) {
        // production driver waits + retries the same cursor; here we just retry
        continue;
      }
      throw e;
    }
  }
  throw new Error('did not terminate');
}

test('targeting selects top-N by score and seeds processing', async () => {
  const r = await advancePipeline(baseRun(), fakeExec());
  assert.equal(r.phase, 'processing');
  assert.equal(r.status, 'running');
  assert.deepEqual(r.targets.map((t) => t.name), ['Acme', 'Globex']);
  assert.deepEqual(r.cursor, { targetIndex: 0, step: 'evidence' });
});

test('happy path completes every target through all three steps', async () => {
  const end = await runToEnd(baseRun(), fakeExec());
  assert.equal(end.status, 'done');
  assert.equal(end.phase, 'done');
  assert.equal(end.cursor, null);
  assert.ok(end.completedAt);
  for (const t of end.targets) {
    assert.equal(t.evidence, 'done');
    assert.equal(t.contacts, 'done');
    assert.equal(t.sequence, 'done');
    assert.equal(t.bestContactId, 'c1');
  }
});

test('no targets found ends the run cleanly', async () => {
  const end = await runToEnd(baseRun(), fakeExec({ targeting: async () => [] }));
  assert.equal(end.status, 'done');
  assert.equal(end.targets.length, 0);
});

test('a failing evidence step marks the whole target failed and moves on', async () => {
  let calls = 0;
  const exec = fakeExec({
    evidence: async () => {
      calls++;
      if (calls === 1) throw new Error('parse_failed'); // first target only
    },
  });
  const end = await runToEnd(baseRun(), exec);
  assert.equal(end.status, 'done');
  assert.equal(end.targets[0].evidence, 'failed');
  assert.equal(end.targets[0].contacts, 'failed');
  assert.equal(end.targets[0].sequence, 'failed');
  // second target still processed fully
  assert.equal(end.targets[1].evidence, 'done');
  assert.equal(end.targets[1].sequence, 'done');
});

test('a target with no contacts fails only the draft step', async () => {
  const exec = fakeExec({ contacts: async () => [] });
  const end = await runToEnd(baseRun(), exec);
  assert.equal(end.status, 'done');
  for (const t of end.targets) {
    assert.equal(t.evidence, 'done');
    assert.equal(t.contacts, 'done');
    assert.equal(t.sequence, 'failed');
  }
});

test('daily-limit pauses the run and preserves the cursor for resume', async () => {
  const exec = fakeExec({
    contacts: async () => {
      throw new PipelineDailyLimitError('Daily agent run limit reached.');
    },
  });
  const end = await runToEnd(baseRun(), exec);
  assert.equal(end.status, 'paused');
  // cursor still points at the contacts step of the first target
  assert.deepEqual(end.cursor, { targetIndex: 0, step: 'contacts' });
  assert.equal(end.targets[0].evidence, 'done');
});

test('rate-limit (per-minute) is retryable — it does not corrupt state', async () => {
  let first = true;
  const exec = fakeExec({
    evidence: async () => {
      if (first) {
        first = false;
        throw new PipelineRateLimitError('slow down');
      }
    },
  });
  const end = await runToEnd(baseRun(), exec);
  assert.equal(end.status, 'done');
  assert.equal(end.targets[0].evidence, 'done');
});

test('a canceled run is a no-op for the reducer', async () => {
  const r = await advancePipeline(baseRun({ status: 'canceled' }), fakeExec());
  assert.equal(r.status, 'canceled');
  assert.equal(r.phase, 'targeting'); // untouched
});

test('the reducer does not mutate the input run', async () => {
  const input = baseRun();
  const snapshot = JSON.stringify(input);
  await advancePipeline(input, fakeExec());
  assert.equal(JSON.stringify(input), snapshot);
});
