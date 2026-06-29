import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emailKeyOf, identityKeyOf, heatPenalty } from './contacted';

describe('contacted key helpers', () => {
  it('emailKeyOf lower-cases and trims, null for blanks', () => {
    assert.equal(emailKeyOf('  Ada@Acme.CO '), 'ada@acme.co');
    assert.equal(emailKeyOf(''), null);
    assert.equal(emailKeyOf(null), null);
  });

  it('identityKeyOf mirrors the contacts.ts contactKey shape', () => {
    assert.equal(identityKeyOf('https://LinkedIn.com/in/Ada', 'Ada Lovelace'), 'https://linkedin.com/in/ada|ada lovelace');
    assert.equal(identityKeyOf(null, 'Ada Lovelace'), '|ada lovelace');
  });
});

describe('heatPenalty - cross-account diversity down-rank', () => {
  const now = new Date('2026-06-29T00:00:00Z');

  it('is 1.0 (no penalty) for an un-contacted profile', () => {
    assert.equal(heatPenalty(undefined, now), 1);
    assert.equal(heatPenalty({ sends: 0, lastContactedAt: now }, now), 1);
  });

  it('down-ranks a freshly-blasted profile but never below the floor', () => {
    const hot = heatPenalty({ sends: 50, lastContactedAt: now }, now);
    assert.ok(hot < 1, 'heavily-contacted profile is penalized');
    assert.ok(hot >= 0.5, 'never eliminated, only down-ranked');
  });

  it('decays back toward 1.0 as the last contact ages out', () => {
    const recent = heatPenalty({ sends: 10, lastContactedAt: now }, now);
    const old = heatPenalty({ sends: 10, lastContactedAt: new Date('2026-01-01T00:00:00Z') }, now);
    assert.ok(old > recent, 'an old contact cools off and the penalty relaxes');
  });

  it('penalizes more sends harder', () => {
    const few = heatPenalty({ sends: 2, lastContactedAt: now }, now);
    const many = heatPenalty({ sends: 100, lastContactedAt: now }, now);
    assert.ok(many < few);
  });
});
