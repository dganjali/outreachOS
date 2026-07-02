// Target-data ops (Phase 3c): the steering chat editing the discovered target
// set directly. Pure-ish - a fake scope captures the writes; no DB/LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTargetOps, hasTargetOps } from './steer';

function fakeScope() {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scope = {
    collection() {
      return {
        insertOne: async (doc: Record<string, unknown>) => {
          inserts.push(doc);
          return doc;
        },
        updateById: async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return 1;
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { scope: scope as any, inserts, updates };
}

describe('hasTargetOps', () => {
  it('is false for empty/absent ops and true when any op is present', () => {
    assert.equal(hasTargetOps(undefined), false);
    assert.equal(hasTargetOps({}), false);
    assert.equal(hasTargetOps({ add: [] }), false);
    assert.equal(hasTargetOps({ add: ['Acme'] }), true);
    assert.equal(hasTargetOps({ removeIds: ['t1'] }), true);
    assert.equal(hasTargetOps({ pinIds: ['t1'] }), true);
  });
});

describe('applyTargetOps', () => {
  it('removes/pins only valid ids and adds new manual targets', async () => {
    const { scope, inserts, updates } = fakeScope();
    const valid = new Set(['t1', 't2']);
    const tally = await applyTargetOps(
      scope,
      'm1',
      { removeIds: ['t1', 'stranger'], pinIds: ['t2'], add: ['Acme', ' Globex '] },
      valid
    );

    assert.deepEqual(tally, { added: 2, removed: 1, pinned: 1 });
    // The stranger id (not owned) is dropped.
    assert.deepEqual(
      updates.map((u) => ({ id: u.id, status: u.patch.status })).sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 't1', status: 'rejected' },
        { id: 't2', status: 'approved' },
      ]
    );
    // Added targets are manual, suggested, and carry the mission id + trimmed name.
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts.map((d) => d.companyName), ['Acme', 'Globex']);
    assert.ok(inserts.every((d) => d.missionId === 'm1' && d.source === 'manual' && d.status === 'suggested'));
  });

  it('dedupes + caps added names', async () => {
    const { scope, inserts } = fakeScope();
    const many = Array.from({ length: 15 }, (_, i) => `Co ${i}`);
    const tally = await applyTargetOps(scope, 'm1', { add: ['Dup', 'Dup', ...many] }, new Set());
    assert.equal(tally.added, 10); // MAX_TARGETS_ADD
    assert.equal(inserts.length, 10);
  });
});
