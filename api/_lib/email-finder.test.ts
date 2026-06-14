import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFindEmailResponse, findEmail } from './email-finder';

describe('parseFindEmailResponse', () => {
  it('returns a well-formed valid_email lowercased', () => {
    assert.equal(parseFindEmailResponse({ valid_email: 'Jane.Doe@Acme.com' }), 'jane.doe@acme.com');
  });

  it('returns null when valid_email is null', () => {
    assert.equal(parseFindEmailResponse({ valid_email: null }), null);
  });

  it('returns null when valid_email is absent', () => {
    assert.equal(parseFindEmailResponse({ credits_charged: 0, input: {} }), null);
  });

  it('returns null for a non-object body', () => {
    assert.equal(parseFindEmailResponse(null), null);
    assert.equal(parseFindEmailResponse('jane@acme.com'), null);
    assert.equal(parseFindEmailResponse(42), null);
  });

  it('returns null for a malformed email string', () => {
    assert.equal(parseFindEmailResponse({ valid_email: 'not-an-email' }), null);
    assert.equal(parseFindEmailResponse({ valid_email: 'jane@acme' }), null);
    assert.equal(parseFindEmailResponse({ valid_email: '   ' }), null);
  });
});

describe('findEmail', () => {
  it('returns null without hitting the network when inputs are empty', async () => {
    assert.deepEqual(await findEmail({ fullName: '', domain: 'acme.com' }), { email: null, raw: null });
    assert.deepEqual(await findEmail({ fullName: 'Jane Doe', domain: '' }), { email: null, raw: null });
  });

  // Live test - only runs with a real key. Costs ≤1 credit, and only on a hit.
  test('live: resolves a known public email or returns null', {
    skip: !process.env.EMAILFINDER_API_KEY,
  }, async () => {
    const r = await findEmail({ fullName: 'Patrick Collison', domain: 'stripe.com' });
    assert.ok(r.email === null || /@stripe\.com$/.test(r.email));
  });
});
