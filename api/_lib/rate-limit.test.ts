// Unit tests for the in-memory IP rate limiter. Run with: npm test
//
// Exercises the pure `consume` core (the middleware is a thin wrapper around
// it) plus the configured auth limiter's 5-attempts/15-min contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consume, __resetRateLimitStore } from './rate-limit';

test('allows up to `max` requests, then blocks within the window', () => {
  __resetRateLimitStore();
  const now = 1_000_000;
  // 5 allowed
  for (let i = 0; i < 5; i++) {
    const r = consume('auth', '1.2.3.4', 5, 15 * 60_000, now);
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  // 6th blocked
  const sixth = consume('auth', '1.2.3.4', 5, 15 * 60_000, now);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.remaining, 0);
  assert.ok(sixth.resetMs > 0 && sixth.resetMs <= 15 * 60_000);
});

test('counter resets after the window elapses', () => {
  __resetRateLimitStore();
  const start = 5_000_000;
  for (let i = 0; i < 5; i++) consume('auth', 'ip', 5, 15 * 60_000, start);
  assert.equal(consume('auth', 'ip', 5, 15 * 60_000, start).allowed, false);
  // Past the window - fresh budget.
  const later = start + 15 * 60_000 + 1;
  assert.equal(consume('auth', 'ip', 5, 15 * 60_000, later).allowed, true);
});

test('keys are isolated by IP and by limiter name', () => {
  __resetRateLimitStore();
  const now = 9_000_000;
  for (let i = 0; i < 5; i++) consume('auth', 'a', 5, 15 * 60_000, now);
  // Different IP - independent budget.
  assert.equal(consume('auth', 'b', 5, 15 * 60_000, now).allowed, true);
  // Same IP, different limiter namespace - independent budget.
  assert.equal(consume('global', 'a', 120, 60_000, now).allowed, true);
});

test('remaining count decrements correctly', () => {
  __resetRateLimitStore();
  const now = 11_000_000;
  assert.equal(consume('global', 'x', 3, 60_000, now).remaining, 2);
  assert.equal(consume('global', 'x', 3, 60_000, now).remaining, 1);
  assert.equal(consume('global', 'x', 3, 60_000, now).remaining, 0);
});
