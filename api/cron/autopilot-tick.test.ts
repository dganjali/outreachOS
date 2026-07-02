import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gateAndQueue, type AutopilotCtx } from './autopilot-tick';

// A minimal fake of the per-user scope: only the collection methods gateAndQueue
// touches on the review path (find/findById/updateById). autoSend is left off so
// nothing reaches evaluateSend (which would hit the network).
function fakeScope(drafts: Array<{ _id: string; contactId: string }>, contacts: Record<string, unknown>) {
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scope = {
    collection(name: string) {
      if (name === 'email_sequences') {
        return {
          find: async () => drafts,
          updateById: async (id: string, patch: Record<string, unknown>) => {
            updated.push({ id, patch });
            return 1;
          },
        };
      }
      if (name === 'contacts') {
        return {
          findById: async (id: string) => {
            const c = contacts[id];
            if (c === 'throw') throw new Error('contact lookup boom');
            return c ?? null;
          },
        };
      }
      return {};
    },
  };
  return { scope, updated };
}

// review-first (autoSend off) so the gate never calls evaluateSend in this test.
function ctx(): AutopilotCtx {
  return {
    recipeId: 'r1',
    missionId: 'm1',
    view: {
      enabled: true,
      autoSend: false,
      cycleIntervalHours: 24,
      lastSourcedAt: null,
      dailySendCap: 10,
      sendWindow: { startHour: 9, endHour: 17 },
      timezone: 'UTC',
      minConfidence: 0.6,
      counter: null,
    },
    send: {
      type: 'send',
      enabled: true,
      autoSend: false,
      cycleIntervalHours: 24,
      dailySendCap: 10,
      sendWindow: { startHour: 9, endHour: 17 },
      timezone: 'UTC',
      lastSourcedAt: null,
      counter: null,
    },
  };
}

describe('gateAndQueue', () => {
  it('isolates a per-draft failure so the rest of the batch still gets gated', async () => {
    const drafts = [
      { _id: 's1', contactId: 'c1' },
      { _id: 's2', contactId: 'c2' }, // this contact lookup throws
      { _id: 's3', contactId: 'c3' },
    ];
    const contacts = {
      c1: { emailStatus: 'none', confidence: 0.9, email: null }, // → review
      c2: 'throw',
      c3: { emailStatus: 'none', confidence: 0.9, email: null }, // → review
    };
    const { scope, updated } = fakeScope(drafts, contacts);
    const out = { policyId: 'r1', sourced: false, gated: 0, queued: 0, reviewed: 0, ready: 0 };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await gateAndQueue(scope as any, ctx(), new Date(), out);

    // The throwing draft is skipped; the two healthy ones are still moved to review.
    assert.equal(out.gated, 2);
    assert.equal(out.reviewed, 2);
    assert.equal(updated.filter((u) => u.patch.autopilotState === 'review').length, 2);
    assert.deepEqual(
      updated.map((u) => u.id).sort(),
      ['s1', 's3'],
    );
  });
});
