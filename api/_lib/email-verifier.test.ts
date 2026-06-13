import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapResult, parseVerifyResponse } from './email-verifier';

describe('mapResult', () => {
  it('confirms ok as verified', () => {
    assert.equal(mapResult('ok'), 'verified');
  });

  it('discards invalid and disposable', () => {
    assert.equal(mapResult('invalid'), 'invalid');
    assert.equal(mapResult('disposable'), 'invalid');
  });

  it('downgrades catch_all and unknown to likely', () => {
    assert.equal(mapResult('catch_all'), 'likely');
    assert.equal(mapResult('unknown'), 'likely');
  });

  it('treats result:"error" (e.g. out of credits) as an outage → trust the finder', () => {
    // Confirmed live: MillionVerifier returns HTTP 200 with result:"error" when
    // the account is out of credits. This must NOT silently downgrade to likely.
    assert.equal(mapResult('error'), 'verified');
  });

  it('treats any unrecognized verdict as an outage → trust the finder', () => {
    assert.equal(mapResult('something_new'), 'verified');
    assert.equal(mapResult(undefined), 'verified');
  });
});

describe('parseVerifyResponse', () => {
  it('maps a real out-of-credits body to verified (outage fallback)', () => {
    const body = { email: 'x@y.com', result: 'error', error: 'Insufficient credits', credits: 0 };
    assert.equal(parseVerifyResponse(body), 'verified');
  });

  it('maps a real ok body to verified and a real invalid body to invalid', () => {
    assert.equal(parseVerifyResponse({ result: 'ok' }), 'verified');
    assert.equal(parseVerifyResponse({ result: 'invalid' }), 'invalid');
  });

  it('falls back to verified for a non-object body', () => {
    assert.equal(parseVerifyResponse(null), 'verified');
    assert.equal(parseVerifyResponse('nope'), 'verified');
  });
});
