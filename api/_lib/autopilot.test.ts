// Unit tests for the Autopilot decision logic — the pure functions the cron
// driver builds on: the confidence gate, the send window, day boundaries, and
// policy-patch sanitization.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGate,
  withinSendWindow,
  startOfUtcDay,
  sanitizePolicyPatch,
  defaultPolicyFields,
} from './autopilot';

const gatePolicy = { minContactConfidence: 0.6, requireVerifiedEmail: true };

test('gate passes a confident, verified, evidenced draft', () => {
  const r = evaluateGate(gatePolicy, {
    contactConfidence: 0.8,
    emailStatus: 'verified',
    hasEmail: true,
    hasEvidence: true,
  });
  assert.deepEqual(r, { pass: true, reason: 'ok' });
});

test('gate holds drafts with no recipient email', () => {
  const r = evaluateGate(gatePolicy, { contactConfidence: 0.9, emailStatus: 'verified', hasEmail: false, hasEvidence: true });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no_email');
});

test('gate holds low-confidence contacts', () => {
  const r = evaluateGate(gatePolicy, { contactConfidence: 0.5, emailStatus: 'verified', hasEmail: true, hasEvidence: true });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'low_confidence');
});

test('gate holds guessed emails when verification is required', () => {
  const r = evaluateGate(gatePolicy, { contactConfidence: 0.9, emailStatus: 'guessed', hasEmail: true, hasEvidence: true });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'unverified_email');
});

test('gate allows guessed emails when verification is not required', () => {
  const r = evaluateGate({ minContactConfidence: 0.6, requireVerifiedEmail: false }, {
    contactConfidence: 0.9,
    emailStatus: 'guessed',
    hasEmail: true,
    hasEvidence: true,
  });
  assert.equal(r.pass, true);
});

test('gate holds drafts with no evidence', () => {
  const r = evaluateGate(gatePolicy, { contactConfidence: 0.9, emailStatus: 'likely', hasEmail: true, hasEvidence: false });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'no_evidence');
});

test('gate treats null confidence as zero', () => {
  const r = evaluateGate(gatePolicy, { contactConfidence: null, emailStatus: 'verified', hasEmail: true, hasEvidence: true });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'low_confidence');
});

const win = { sendWindowStartHour: 13, sendWindowEndHour: 21, sendDays: [1, 2, 3, 4, 5] };

test('send window respects hour bounds (UTC)', () => {
  assert.equal(withinSendWindow(win, new Date('2026-06-15T14:00:00Z')), true); // Mon 14:00
  assert.equal(withinSendWindow(win, new Date('2026-06-15T21:00:00Z')), false); // exclusive end
  assert.equal(withinSendWindow(win, new Date('2026-06-15T12:59:00Z')), false); // before start
});

test('send window respects allowed weekdays', () => {
  assert.equal(withinSendWindow(win, new Date('2026-06-14T14:00:00Z')), false); // Sunday
  assert.equal(withinSendWindow(win, new Date('2026-06-13T14:00:00Z')), false); // Saturday
});

test('send window that wraps past midnight', () => {
  const overnight = { sendWindowStartHour: 22, sendWindowEndHour: 2, sendDays: [] };
  assert.equal(withinSendWindow(overnight, new Date('2026-06-15T23:00:00Z')), true);
  assert.equal(withinSendWindow(overnight, new Date('2026-06-15T01:00:00Z')), true);
  assert.equal(withinSendWindow(overnight, new Date('2026-06-15T12:00:00Z')), false);
});

test('equal start/end means a 24h window', () => {
  const allDay = { sendWindowStartHour: 0, sendWindowEndHour: 0, sendDays: [] };
  assert.equal(withinSendWindow(allDay, new Date('2026-06-15T03:00:00Z')), true);
});

test('startOfUtcDay zeroes the time', () => {
  const d = startOfUtcDay(new Date('2026-06-15T18:42:11Z'));
  assert.equal(d.toISOString(), '2026-06-15T00:00:00.000Z');
});

test('sanitizePolicyPatch clamps and coerces fields', () => {
  const p = sanitizePolicyPatch({
    enabled: 'yes',
    targetsPerWeek: 9999,
    maxSendsPerDay: -5,
    sendWindowStartHour: 30,
    minContactConfidence: 2,
    sendDays: [1, 1, 7, 3, 'x'],
    bogus: 'ignored',
  });
  assert.equal(p.enabled, true);
  assert.equal(p.targetsPerWeek, 200);
  assert.equal(p.maxSendsPerDay, 0);
  assert.equal(p.sendWindowStartHour, 23);
  assert.equal(p.minContactConfidence, 1);
  assert.deepEqual(p.sendDays, [1, 3]); // deduped, 7 and 'x' dropped
  assert.equal('bogus' in p, false);
});

test('default policy starts disabled and in draft-only mode', () => {
  const d = defaultPolicyFields();
  assert.equal(d.enabled, false);
  assert.equal(d.autoSend, false);
  assert.equal(d.requireVerifiedEmail, true);
});
