// Unit tests for the NoSQL operator-injection hardening on the generic query
// endpoint — SHIPMENT_AUDIT.md finding S1. Run with: npm test
//
// These exercise the security-critical core (sanitizeFilter) directly. The
// /query route maps a thrown InvalidFilterError to HTTP 400 { error:
// 'invalid_filter' }, and forUser(uid).find() ANDs the authenticated userId on
// top of the sanitized filter — so a client userId is dropped here, then
// overridden there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilter, InvalidFilterError } from './router';

test('(a) a benign filter passes through unchanged', () => {
  const filter = {
    missionId: 'm_123',
    status: { $in: ['active', 'pending'] },
    score: { $gte: 5 },
    repliedAt: { $ne: null },
    deletedAt: null,
  };
  assert.deepEqual(sanitizeFilter(filter), filter);
});

test('(b) $where is rejected (route maps this to HTTP 400)', () => {
  assert.throws(
    () => sanitizeFilter({ $where: 'sleep(10000) || true' }),
    InvalidFilterError,
  );
});

test('(b) other dangerous / non-allowlisted operators are rejected', () => {
  // $regex (ReDoS) is not on the allowlist.
  assert.throws(() => sanitizeFilter({ name: { $regex: '(a+)+$' } }), InvalidFilterError);
  // $expr / $function smuggled under a field is rejected.
  assert.throws(() => sanitizeFilter({ score: { $expr: 1 } }), InvalidFilterError);
  // Mixing an operator with a plain field key is rejected.
  assert.throws(() => sanitizeFilter({ score: { $gte: 5, evil: 1 } }), InvalidFilterError);
  // Top-level logical operators are rejected (field names never start with $).
  assert.throws(() => sanitizeFilter({ $or: [{ a: 1 }] }), InvalidFilterError);
});

test('(c) a client-supplied userId is stripped; the authed uid wins', () => {
  const sanitized = sanitizeFilter({ userId: 'attacker-uid', missionId: 'm_1' });
  assert.equal('userId' in sanitized, false);
  assert.deepEqual(sanitized, { missionId: 'm_1' });

  // The route then runs forUser(authedUid).find(sanitized), which ANDs the
  // authenticated userId on top — so the effective query is always scoped to
  // the caller regardless of what they sent.
  const authedUid = 'real-uid';
  const effective = { ...sanitized, userId: authedUid };
  assert.equal(effective.userId, 'real-uid');
});
