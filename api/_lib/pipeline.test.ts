// Unit tests for the parallel pipeline processor (runPipeline). These exercise
// the durable state machine directly with fake executors + a fake persist - no
// Mongo, no network - covering targeting selection, the parallel happy path,
// partial failures, the daily-limit pause/resume, per-minute retry, that
// targets run concurrently, and that evidence + contacts run as one research
// phase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runPipeline,
  PipelineDailyLimitError,
  PipelineRateLimitError,
  type PipelineExecutors,
  type ProcContext,
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
    config: { targetCount: 8, topN: 3, topContacts: 1 },
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
    reserve: async () => [],
    markRejected: async () => undefined,
    ...over,
  };
}

// A context wired to fake executors. Persist/sleep are no-ops; concurrency and a
// zero stagger keep tests fast and deterministic.
function ctxFor(exec: PipelineExecutors, over: Partial<ProcContext> = {}): ProcContext {
  return {
    exec,
    concurrency: 3,
    contactConcurrency: 2,
    launchStaggerMs: 0,
    minuteRetryMax: 3,
    minuteRetryWaitMs: 0,
    paused: false,
    canceled: false,
    persist: async () => undefined,
    persistStatus: async () => undefined,
    sleep: async () => undefined,
    ...over,
  };
}

test('the run config contact-type filter reaches the contacts executor', async () => {
  const seen: Array<{ functions?: string[]; seniority?: string[] }> = [];
  const exec = fakeExec({
    contacts: async (_targetId, filter) => {
      seen.push({ functions: filter?.functions, seniority: filter?.seniority });
      return [{ id: 'c1', confidence: 0.8 }];
    },
  });
  await runPipeline(
    baseRun({
      config: {
        targetCount: 8,
        topN: 1,
        topContacts: 1,
        selectedFunctions: ['community'],
        selectedSeniority: ['manager'],
      },
    }),
    ctxFor(exec)
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].functions, ['community']);
  assert.deepEqual(seen[0].seniority, ['manager']);
});

test('the run config sector filter reaches the targeting executor', async () => {
  const seen: string[][] = [];
  const exec = fakeExec({
    targeting: async (_missionId, _count, sectors) => {
      seen.push(sectors ?? []);
      return [{ id: 't1', name: 'Acme', score: 0.9 }];
    },
  });
  await runPipeline(
    baseRun({
      config: {
        targetCount: 8,
        topN: 1,
        topContacts: 1,
        selectedSectors: ['fintech', 'developer tools'],
      },
    }),
    ctxFor(exec)
  );
  assert.deepEqual(seen[0], ['fintech', 'developer tools']);
});

test('targeting selects top-N by score and processes them', async () => {
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 1, topContacts: 1 } }), ctxFor(fakeExec()));
  assert.equal(end.phase, 'done');
  // Only the top-scored target was pursued.
  assert.deepEqual(end.targets.map((t) => t.name), ['Acme']);
});

test('happy path completes every target through all three steps', async () => {
  const end = await runPipeline(baseRun(), ctxFor(fakeExec()));
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

test('evidence and contacts run concurrently within a target', async () => {
  let bothInFlight = false;
  let evidenceRunning = false;
  let contactsRunning = false;
  const exec = fakeExec({
    targeting: async () => [{ id: 't1', name: 'Acme', score: 0.9 }],
    evidence: async () => {
      evidenceRunning = true;
      await new Promise((r) => setTimeout(r, 5));
      if (contactsRunning) bothInFlight = true;
      evidenceRunning = false;
    },
    contacts: async () => {
      contactsRunning = true;
      await new Promise((r) => setTimeout(r, 5));
      if (evidenceRunning) bothInFlight = true;
      contactsRunning = false;
      return [{ id: 'c1', confidence: 0.8 }];
    },
  });
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 1, topContacts: 1 } }), ctxFor(exec));
  assert.equal(end.status, 'done');
  assert.ok(bothInFlight, 'evidence and contacts should overlap');
});

test('topContacts drafts the top N contacts per target', async () => {
  let sequenceCalls = 0;
  const exec = fakeExec({
    targeting: async () => [{ id: 't1', name: 'Acme', score: 0.9 }],
    contacts: async () => [
      { id: 'c1', confidence: 0.9 },
      { id: 'c2', confidence: 0.7 },
      { id: 'c3', confidence: 0.5 },
      { id: 'c4', confidence: 0.3 },
    ],
    sequence: async () => {
      sequenceCalls++;
    },
  });
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 3, topContacts: 3 } }), ctxFor(exec));
  assert.equal(end.status, 'done');
  const t = end.targets[0];
  assert.deepEqual([...t.contactIds].sort(), ['c1', 'c2', 'c3']); // capped at topContacts, by confidence
  assert.equal(t.bestContactId, 'c1');
  assert.equal(t.sequences.filter((s) => s === 'done').length, 3);
  assert.equal(t.sequence, 'done');
  assert.equal(sequenceCalls, 3);
});

test('a target draft step is done if any contact draft succeeds', async () => {
  const exec = fakeExec({
    targeting: async () => [{ id: 't1', name: 'Acme', score: 0.9 }],
    contacts: async () => [
      { id: 'c1', confidence: 0.9 },
      { id: 'c2', confidence: 0.7 },
    ],
    sequence: async (id) => {
      if (id === 'c1') throw new Error('draft_failed'); // top contact fails
    },
  });
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 3, topContacts: 2 } }), ctxFor(exec));
  const t = end.targets[0];
  assert.equal(t.sequences[0], 'failed');
  assert.equal(t.sequences[1], 'done');
  assert.equal(t.sequence, 'done');
});

test('no targets found ends the run cleanly', async () => {
  const end = await runPipeline(baseRun(), ctxFor(fakeExec({ targeting: async () => [] })));
  assert.equal(end.status, 'done');
  assert.equal(end.targets.length, 0);
});

test('a failing evidence step marks the whole target failed; others still complete', async () => {
  const exec = fakeExec({
    evidence: async (targetId) => {
      if (targetId === 't1') throw new Error('parse_failed'); // first target only
    },
  });
  const end = await runPipeline(baseRun(), ctxFor(exec));
  assert.equal(end.status, 'done');
  const t1 = end.targets.find((t) => t.targetId === 't1')!;
  const t2 = end.targets.find((t) => t.targetId === 't2')!;
  assert.equal(t1.evidence, 'failed');
  assert.equal(t1.contacts, 'failed'); // evidence is the precondition - cascades
  assert.equal(t1.sequence, 'failed');
  assert.equal(t2.evidence, 'done');
  assert.equal(t2.sequence, 'done');
});

test('a contactless company is dropped (rejected) when no replacement exists', async () => {
  const rejected: string[] = [];
  const exec = fakeExec({
    contacts: async () => [],
    markRejected: async (id) => {
      rejected.push(id);
    },
  });
  const end = await runPipeline(baseRun(), ctxFor(exec));
  assert.equal(end.status, 'done');
  for (const t of end.targets) {
    assert.equal(t.evidence, 'done');
    assert.equal(t.contacts, 'done');
    assert.equal(t.sequence, 'failed');
  }
  // Both pursued companies came up empty; with no reserve/new discovery they're
  // dropped from the user-facing output rather than shown as empty cards.
  assert.deepEqual([...rejected].sort(), ['t1', 't2']);
});

test('a contactless company is dropped and replaced from the reserve', async () => {
  const rejected: string[] = [];
  const exec = fakeExec({
    targeting: async () => [{ id: 't1', name: 'Acme', score: 0.9 }],
    contacts: async (targetId) => (targetId === 't1' ? [] : [{ id: `${targetId}-c1`, confidence: 0.8 }]),
    reserve: async (_missionId, exclude) =>
      ['t2', 't3'].filter((id) => !exclude.includes(id)).map((id) => ({ id, name: id, score: 0.5 })),
    markRejected: async (id) => {
      rejected.push(id);
    },
  });
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 1, topContacts: 1 } }), ctxFor(exec));
  assert.equal(end.status, 'done');
  assert.deepEqual(rejected, ['t1']); // the empty company was dropped
  const delivered = end.targets.filter((t) => t.contacts === 'done' && t.contactIds.length > 0);
  assert.equal(delivered.length, 1); // backfilled to the requested company count
  assert.equal(delivered[0].targetId, 't2'); // next-best reserve company
});

test('exhausted reserve triggers re-discovery for replacements', async () => {
  let targetingCalls = 0;
  const exec = fakeExec({
    targeting: async () => {
      targetingCalls++;
      // First call seeds the original company; later calls discover a fresh one.
      return targetingCalls === 1
        ? [{ id: 't1', name: 'Acme', score: 0.9 }]
        : [{ id: 't9', name: 'Newco', score: 0.6 }];
    },
    contacts: async (targetId) => (targetId === 't1' ? [] : [{ id: `${targetId}-c1`, confidence: 0.8 }]),
    reserve: async () => [], // nothing on the bench → must re-discover
  });
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 1, topContacts: 1 } }), ctxFor(exec));
  assert.equal(end.status, 'done');
  assert.ok(targetingCalls >= 2, 're-discovery ran once the reserve was empty');
  const delivered = end.targets.filter((t) => t.contacts === 'done' && t.contactIds.length > 0);
  assert.deepEqual(delivered.map((t) => t.targetId), ['t9']);
});

test('daily-limit pauses the run and preserves untouched targets for resume', async () => {
  const exec = fakeExec({
    targeting: async () => [
      { id: 't1', name: 'Acme', score: 0.9 },
      { id: 't2', name: 'Globex', score: 0.8 },
      { id: 't3', name: 'Initech', score: 0.7 },
    ],
    contacts: async () => {
      throw new PipelineDailyLimitError('Daily agent run limit reached.');
    },
  });
  // concurrency 1 so only t1 is touched before the pause.
  const end = await runPipeline(
    baseRun({ config: { targetCount: 8, topN: 3, topContacts: 1 } }),
    ctxFor(exec, { concurrency: 1 })
  );
  assert.equal(end.status, 'paused');
  const t1 = end.targets.find((t) => t.targetId === 't1')!;
  assert.equal(t1.evidence, 'done'); // evidence succeeded in the research phase
  assert.equal(t1.contacts, 'queued'); // reverted so resume re-runs only contacts
  // Targets never reached stay fully queued.
  for (const id of ['t2', 't3']) {
    const t = end.targets.find((x) => x.targetId === id)!;
    assert.equal(t.evidence, 'queued');
    assert.equal(t.sequence, 'queued');
  }
});

test('re-driving a stale processing run only finishes the unfinished targets (idempotent resume)', async () => {
  // Simulate a driver that died mid-run: t1 fully done, t2 still queued. This is
  // the state resumeIfStale re-drives (a 'running' run with a stale heartbeat).
  let evidenceCalls = 0;
  const exec = fakeExec({
    evidence: async () => {
      evidenceCalls++;
    },
    contacts: async (targetId) => [{ id: `${targetId}-c1`, confidence: 0.8 }],
  });
  const partial = baseRun({
    status: 'running',
    phase: 'processing',
    config: { targetCount: 8, topN: 2, topContacts: 1 },
    cursor: null,
    targets: [
      {
        targetId: 't1',
        name: 'Acme',
        score: 0.9,
        evidence: 'done',
        contacts: 'done',
        sequence: 'done',
        contactIds: ['t1-c1'],
        sequences: ['done'],
        bestContactId: 't1-c1',
      },
      {
        targetId: 't2',
        name: 'Globex',
        score: 0.8,
        evidence: 'queued',
        contacts: 'queued',
        sequence: 'queued',
        contactIds: [],
        sequences: [],
        bestContactId: null,
      },
    ],
  });
  const end = await runPipeline(partial, ctxFor(exec));
  assert.equal(end.status, 'done');
  assert.equal(evidenceCalls, 1); // only t2 re-ran; t1's done work was not redone
  const t2 = end.targets.find((t) => t.targetId === 't2')!;
  assert.equal(t2.evidence, 'done');
  assert.equal(t2.contacts, 'done');
  assert.equal(t2.sequence, 'done');
});

test('per-minute rate-limit is retried and does not corrupt state', async () => {
  let first = true;
  const exec = fakeExec({
    evidence: async () => {
      if (first) {
        first = false;
        throw new PipelineRateLimitError('slow down');
      }
    },
  });
  const end = await runPipeline(baseRun(), ctxFor(exec));
  assert.equal(end.status, 'done');
  for (const t of end.targets) assert.equal(t.evidence, 'done');
});

test('targets run concurrently', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const exec = fakeExec({
    targeting: async () => [
      { id: 't1', name: 'Acme', score: 0.9 },
      { id: 't2', name: 'Globex', score: 0.8 },
      { id: 't3', name: 'Initech', score: 0.7 },
    ],
    evidence: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    },
  });
  const end = await runPipeline(baseRun({ config: { targetCount: 8, topN: 3, topContacts: 1 } }), ctxFor(exec, { concurrency: 3 }));
  assert.equal(end.status, 'done');
  assert.ok(maxInFlight >= 2, `expected overlap, saw max ${maxInFlight}`);
});

test('an observed cancel stops the run without finishing it', async () => {
  const exec = fakeExec();
  const ctx = ctxFor(exec, { concurrency: 1, checkCanceled: async () => true });
  const end = await runPipeline(baseRun(), ctx);
  // Cancel is observed before any target runs; status is left for cancelPipeline.
  assert.notEqual(end.status, 'done');
});

test('runPipeline does not mutate the input run', async () => {
  const input = baseRun();
  const snapshot = JSON.stringify(input);
  await runPipeline(input, ctxFor(fakeExec()));
  assert.equal(JSON.stringify(input), snapshot);
});
