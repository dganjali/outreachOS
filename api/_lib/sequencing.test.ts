import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleFollowups } from './sequencing';
import type { EmailSequenceDoc, SentMessageDoc } from '../../shared/schemas';
import type { UserScope } from './db';

// Minimal in-memory sent_messages collection so we can assert exactly which
// follow-up touches scheduleFollowups queues (and with what timing).
function fakeScope(): { scope: UserScope; inserted: SentMessageDoc[] } {
  const inserted: SentMessageDoc[] = [];
  const sent = {
    findOne: async () => null, // nothing pre-existing
    insertOne: async (doc: SentMessageDoc) => {
      inserted.push(doc);
      return doc;
    },
  };
  const scope = {
    collection: () => sent,
  } as unknown as UserScope;
  return { scope, inserted };
}

function seq(followups: EmailSequenceDoc['followups']): EmailSequenceDoc {
  return {
    _id: 'seq1',
    contactId: 'c1',
    missionId: 'm1',
    profileVersionId: null,
    followups,
  } as unknown as EmailSequenceDoc;
}

describe('scheduleFollowups', () => {
  const sentAt = new Date('2026-06-25T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;

  it('queues every follow-up when none are disabled', async () => {
    const { scope, inserted } = fakeScope();
    const n = await scheduleFollowups({
      scope,
      seq: seq([
        { waitDays: 3, subject: 'a', body: 'a' },
        { waitDays: 4, subject: 'b', body: 'b' },
      ]),
      toEmail: 'x@y.com',
      sentAt,
    });
    assert.equal(n, 2);
    assert.deepEqual(inserted.map((m) => m.touchIndex), [1, 2]);
    // Cumulative cadence: +3 days, then +4 more.
    assert.equal(inserted[0].scheduledSendAt!.getTime(), sentAt.getTime() + 3 * day);
    assert.equal(inserted[1].scheduledSendAt!.getTime(), sentAt.getTime() + 7 * day);
  });

  it('skips a disabled follow-up but keeps later touches at their original dates', async () => {
    const { scope, inserted } = fakeScope();
    const n = await scheduleFollowups({
      scope,
      seq: seq([
        { waitDays: 3, subject: 'a', body: 'a', disabled: true },
        { waitDays: 4, subject: 'b', body: 'b' },
      ]),
      toEmail: 'x@y.com',
      sentAt,
    });
    // Only the second touch is queued...
    assert.equal(n, 1);
    // ...and it keeps positional touchIndex 2 (gmail/send reads followups[idx-1])
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].touchIndex, 2);
    // ...and its send date is unchanged (cumulative clock still advanced past the
    // skipped touch): 3 + 4 = 7 days out, not pulled earlier to 4.
    assert.equal(inserted[0].scheduledSendAt!.getTime(), sentAt.getTime() + 7 * day);
  });

  it('queues nothing when all follow-ups are disabled', async () => {
    const { scope, inserted } = fakeScope();
    const n = await scheduleFollowups({
      scope,
      seq: seq([
        { waitDays: 3, subject: 'a', body: 'a', disabled: true },
        { waitDays: 4, subject: 'b', body: 'b', disabled: true },
      ]),
      toEmail: 'x@y.com',
      sentAt,
    });
    assert.equal(n, 0);
    assert.equal(inserted.length, 0);
  });
});
