import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateDecision,
  nextSendSlots,
  sentToday,
  remainingCapToday,
  bumpedCounter,
  sourcingDue,
  withPolicyDefaults,
  tzOffsetMinutes,
  snapToWindow,
  planReschedule,
  type SendPolicy,
} from './autopilot';
import type { ContactDoc } from '../../shared/schemas';

function policy(over: Partial<SendPolicy> = {}): SendPolicy {
  return {
    enabled: true,
    autoSend: true,
    cycleIntervalHours: 24,
    lastSourcedAt: null,
    dailySendCap: 10,
    sendWindow: { startHour: 9, endHour: 17 },
    timezone: 'UTC',
    minConfidence: 0.6,
    counter: null,
    ...over,
  };
}

function contact(over: Partial<ContactDoc> = {}): Pick<ContactDoc, 'emailStatus' | 'confidence'> {
  return { emailStatus: 'verified', confidence: 0.9, ...over } as ContactDoc;
}

describe('gateDecision', () => {
  it('passes a verified address above the confidence threshold', () => {
    assert.equal(gateDecision(contact({ emailStatus: 'verified', confidence: 0.7 }), policy({ minConfidence: 0.6 })), 'auto');
  });
  it('holds a likely/guessed address even at high confidence', () => {
    assert.equal(gateDecision(contact({ emailStatus: 'likely', confidence: 0.99 }), policy()), 'review');
    assert.equal(gateDecision(contact({ emailStatus: 'guessed', confidence: 0.99 }), policy()), 'review');
    assert.equal(gateDecision(contact({ emailStatus: 'none', confidence: 0.99 }), policy()), 'review');
  });
  it('holds a verified address below the threshold', () => {
    assert.equal(gateDecision(contact({ emailStatus: 'verified', confidence: 0.4 }), policy({ minConfidence: 0.6 })), 'review');
  });
  it('treats null confidence as 0', () => {
    assert.equal(gateDecision(contact({ emailStatus: 'verified', confidence: null }), policy({ minConfidence: 0.1 })), 'review');
  });
});

describe('daily counter', () => {
  const now = new Date('2026-06-18T12:00:00Z');
  it('reports 0 when counter is absent or from another day', () => {
    assert.equal(sentToday(policy({ counter: null }), now), 0);
    assert.equal(sentToday(policy({ counter: { date: '2026-06-17', sent: 9 } }), now), 0);
  });
  it('reports the count for today', () => {
    assert.equal(sentToday(policy({ counter: { date: '2026-06-18', sent: 4 } }), now), 4);
  });
  it('computes remaining cap and rolls over on day change', () => {
    assert.equal(remainingCapToday(policy({ dailySendCap: 10, counter: { date: '2026-06-18', sent: 4 } }), now), 6);
    assert.equal(remainingCapToday(policy({ dailySendCap: 10, counter: { date: '2026-06-17', sent: 10 } }), now), 10);
  });
  it('bumps the counter, resetting across the day boundary', () => {
    assert.deepEqual(bumpedCounter(policy({ counter: { date: '2026-06-18', sent: 4 } }), now, 2), { date: '2026-06-18', sent: 6 });
    assert.deepEqual(bumpedCounter(policy({ counter: { date: '2026-06-17', sent: 9 } }), now, 1), { date: '2026-06-18', sent: 1 });
  });
});

describe('sourcingDue', () => {
  const now = new Date('2026-06-18T12:00:00Z');
  it('is due when never sourced', () => {
    assert.equal(sourcingDue(policy({ lastSourcedAt: null }), now), true);
  });
  it('is not due before the interval elapses', () => {
    assert.equal(sourcingDue(policy({ lastSourcedAt: new Date('2026-06-18T06:00:00Z'), cycleIntervalHours: 24 }), now), false);
  });
  it('is due once the interval has passed', () => {
    assert.equal(sourcingDue(policy({ lastSourcedAt: new Date('2026-06-17T06:00:00Z'), cycleIntervalHours: 24 }), now), true);
  });
});

describe('nextSendSlots', () => {
  it('returns [] for non-positive counts', () => {
    assert.deepEqual(nextSendSlots(policy(), 0, new Date()), []);
  });
  it('starts at now when already inside the window (UTC)', () => {
    const now = new Date('2026-06-18T12:00:00Z'); // 12:00, window 9–17
    const slots = nextSendSlots(policy({ timezone: 'UTC' }), 3, now);
    assert.equal(slots.length, 3);
    assert.equal(slots[0].getTime(), now.getTime());
    // ordered and strictly increasing
    assert.ok(slots[1] > slots[0] && slots[2] > slots[1]);
    // all within today's window end (17:00Z)
    const end = new Date('2026-06-18T17:00:00Z').getTime();
    for (const s of slots) assert.ok(s.getTime() <= end);
  });
  it('defers to the next morning when the window has passed (UTC)', () => {
    const now = new Date('2026-06-18T20:00:00Z'); // after 17:00
    const slots = nextSendSlots(policy({ timezone: 'UTC' }), 2, now);
    assert.equal(slots[0].toISOString(), '2026-06-19T09:00:00.000Z');
  });
  it('opens later today when before the window (UTC)', () => {
    const now = new Date('2026-06-18T06:00:00Z'); // before 09:00
    const slots = nextSendSlots(policy({ timezone: 'UTC' }), 1, now);
    assert.equal(slots[0].toISOString(), '2026-06-18T09:00:00.000Z');
  });
  it('honours a non-UTC timezone offset', () => {
    // America/Toronto in June is EDT (UTC-4). 09:00 local = 13:00Z.
    const now = new Date('2026-06-18T06:00:00Z'); // 02:00 local, before window
    const off = tzOffsetMinutes('America/Toronto', now);
    assert.equal(off, -240);
    const slots = nextSendSlots(policy({ timezone: 'America/Toronto' }), 1, now);
    assert.equal(slots[0].toISOString(), '2026-06-18T13:00:00.000Z');
  });
});

describe('snapToWindow', () => {
  it('keeps a time already inside the window (UTC)', () => {
    const d = new Date('2026-06-18T12:00:00Z'); // inside 9-17
    assert.equal(snapToWindow(d, policy({ timezone: 'UTC' })).toISOString(), d.toISOString());
  });
  it('pulls a pre-window time up to the window open, same day (UTC)', () => {
    const d = new Date('2026-06-18T03:00:00Z'); // before 09:00
    assert.equal(snapToWindow(d, policy({ timezone: 'UTC' })).toISOString(), '2026-06-18T09:00:00.000Z');
  });
  it('pulls a post-window time back to the window open, same day (UTC)', () => {
    const d = new Date('2026-06-18T22:00:00Z'); // after 17:00
    assert.equal(snapToWindow(d, policy({ timezone: 'UTC' })).toISOString(), '2026-06-18T09:00:00.000Z');
  });
  it('preserves the calendar day in the policy timezone (Toronto EDT)', () => {
    // 2026-06-19T01:00Z is still 2026-06-18 21:00 local (EDT, UTC-4), after the
    // window ⇒ snap to that local day's 09:00 = 13:00Z on the 18th.
    const d = new Date('2026-06-19T01:00:00Z');
    assert.equal(snapToWindow(d, policy({ timezone: 'America/Toronto' })).toISOString(), '2026-06-18T13:00:00.000Z');
  });
  it('passes through a degenerate window', () => {
    const d = new Date('2026-06-18T22:00:00Z');
    assert.equal(snapToWindow(d, policy({ sendWindow: { startHour: 9, endHour: 9 } })).toISOString(), d.toISOString());
  });
});

describe('planReschedule', () => {
  const now = new Date('2026-06-18T12:00:00Z'); // inside 9-17 UTC
  it('redistributes initial touches into the window, ordered by current time', () => {
    const rows = [
      { id: 'b', touchIndex: 0, scheduledSendAt: new Date('2026-06-18T16:00:00Z') },
      { id: 'a', touchIndex: 0, scheduledSendAt: new Date('2026-06-18T10:00:00Z') },
    ];
    const moves = planReschedule(rows, policy({ timezone: 'UTC' }), now);
    // First slot starts at now; 'a' (earlier) maps to the earliest slot.
    const a = moves.find((m) => m.id === 'a');
    assert.ok(a);
    assert.equal(a!.scheduledSendAt.getTime(), now.getTime());
  });
  it('snaps queued follow-ups into the window but keeps their day', () => {
    const rows = [
      { id: 'f', touchIndex: 1, scheduledSendAt: new Date('2026-06-21T03:00:00Z') }, // 3 days out, pre-window
    ];
    const moves = planReschedule(rows, policy({ timezone: 'UTC' }), now);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].scheduledSendAt.toISOString(), '2026-06-21T09:00:00.000Z');
  });
  it('returns no move for a follow-up already inside the window', () => {
    const rows = [{ id: 'f', touchIndex: 1, scheduledSendAt: new Date('2026-06-21T12:00:00Z') }];
    const moves = planReschedule(rows, policy({ timezone: 'UTC' }), now);
    assert.equal(moves.length, 0);
  });
});

// (withPolicyDefaults was removed when campaign_policies was subsumed by the
// recipe; its clamping is now exercised by recipe.test.ts.)
