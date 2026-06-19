import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  warmupCap,
  connectionAgeDays,
  recipientDomain,
  checkSendAllowance,
  remainingToday,
  PER_DOMAIN_DAILY_CAP,
} from './sending-limits';

describe('warmupCap', () => {
  it('starts conservative and ramps weekly to a ceiling', () => {
    assert.equal(warmupCap(0), 25);
    assert.equal(warmupCap(6), 25); // still week 0
    assert.equal(warmupCap(7), 50); // week 1
    assert.equal(warmupCap(14), 75);
    assert.equal(warmupCap(70), 250); // hit ceiling
    assert.equal(warmupCap(700), 250); // clamped
  });
  it('treats bad input as a fresh connection', () => {
    assert.equal(warmupCap(NaN), 25);
    assert.equal(warmupCap(-5), 25);
  });
});

describe('connectionAgeDays', () => {
  const now = new Date('2026-06-19T12:00:00Z');
  it('floors to whole days and never goes negative', () => {
    assert.equal(connectionAgeDays('2026-06-19T00:00:00Z', now), 0);
    assert.equal(connectionAgeDays('2026-06-12T00:00:00Z', now), 7);
    assert.equal(connectionAgeDays('2026-07-01T00:00:00Z', now), 0); // future
    assert.equal(connectionAgeDays(null, now), 0);
  });
});

describe('recipientDomain', () => {
  it('extracts and lowercases the domain', () => {
    assert.equal(recipientDomain('Person@Acme.COM'), 'acme.com');
    assert.equal(recipientDomain('no-at-sign'), '');
  });
});

describe('checkSendAllowance', () => {
  it('allows when under both caps', () => {
    const r = checkSendAllowance({ ageDays: 0, sentToday: 10, sentToDomainToday: 2 });
    assert.equal(r.allowed, true);
    assert.equal(r.capToday, 25);
  });
  it('blocks at the account daily cap', () => {
    const r = checkSendAllowance({ ageDays: 0, sentToday: 25, sentToDomainToday: 0 });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'account_daily_cap');
  });
  it('blocks at the per-domain cap even with account headroom', () => {
    const r = checkSendAllowance({ ageDays: 70, sentToday: 5, sentToDomainToday: PER_DOMAIN_DAILY_CAP });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'domain_daily_cap');
  });
});

describe('remainingToday', () => {
  it('is cap minus sent, floored at 0', () => {
    assert.equal(remainingToday(0, 10), 15);
    assert.equal(remainingToday(0, 30), 0);
  });
});
