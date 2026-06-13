import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmail, type EmailProvider, type EmailVerifier, type ContactEmailFields } from './email-resolver';
import type { VerifyVerdict } from './email-verifier';
import type { ScrapeResult } from './web-scrape';

const NO_EMAIL: ContactEmailFields = { email: null, emailStatus: 'none', likelyEmailPattern: null };

function scrape(emails: string[], pattern: string | null = null): ScrapeResult {
  return { domain: 'acme.co', emails, pattern, pagesScraped: [] };
}

// A fake finder provider so the cascade is testable without network.
function fakeProvider(email: string | null, enabled = true): EmailProvider {
  return {
    enabled: () => enabled,
    findEmail: async () => ({ email, raw: null }),
  };
}

// A fake verifier so the catch-all gate is testable without network.
function fakeVerifier(verdict: VerifyVerdict, enabled = true): EmailVerifier {
  return {
    enabled: () => enabled,
    verify: async () => verdict,
  };
}

// A disabled verifier matches the default behavior when no MILLIONVERIFIER_API_KEY.
const VERIFIER_OFF = fakeVerifier('verified', false);

describe('resolveEmail cascade', () => {
  it('returns a verified email from the finder before consulting scrape', async () => {
    // Scrape would also match here; the finder must win because it runs first.
    // Verifier explicitly off so this asserts the bare-finder path regardless of
    // any ambient MILLIONVERIFIER_API_KEY in the environment.
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape(['jane.doe@acme.co']), [
      fakeProvider('jane.doe@acme.co'),
    ], VERIFIER_OFF);
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.emailStatus, 'verified');
    assert.equal(r.resolver, 'email_finder');
  });

  it('falls to a real scraped email when the finder misses', async () => {
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape(['jane.doe@acme.co', 'info@acme.co']), [
      fakeProvider(null),
    ]);
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.emailStatus, 'verified');
    assert.equal(r.resolver, 'scrape');
  });

  it('NEVER ships a guess: finder miss + no real scraped match → null/none', async () => {
    // Scraped emails belong to other people; pattern is inferable but must not
    // be promoted to a usable email.
    const r = await resolveEmail('John Smith', 'acme.co', NO_EMAIL, scrape(['jane.doe@acme.co'], 'first.last'), [
      fakeProvider(null),
    ]);
    assert.equal(r.email, null);
    assert.equal(r.emailStatus, 'none');
    assert.equal(r.resolver, 'none');
    assert.equal(r.likelyEmailPattern, 'first.last@acme.co'); // kept for display only
  });

  it('passes a pre-trusted Apollo email through untouched (short-circuit)', async () => {
    const existing: ContactEmailFields = {
      email: 'apollo.person@acme.co',
      emailStatus: 'verified',
      likelyEmailPattern: null,
    };
    let called = false;
    const provider: EmailProvider = { enabled: () => true, findEmail: async () => { called = true; return { email: 'x@acme.co', raw: null }; } };
    const r = await resolveEmail('Apollo Person', 'acme.co', existing, scrape([]), [provider]);
    assert.equal(r.email, 'apollo.person@acme.co');
    assert.equal(r.emailStatus, 'verified');
    assert.equal(r.resolver, 'apollo');
    assert.equal(called, false, 'finder must not be called when a trusted email exists');
  });

  it('re-resolves an Apollo "guessed" email instead of trusting it', async () => {
    const existing: ContactEmailFields = {
      email: 'guess@acme.co',
      emailStatus: 'guessed',
      likelyEmailPattern: null,
    };
    const r = await resolveEmail('Jane Doe', 'acme.co', existing, scrape([]), [fakeProvider('jane.doe@acme.co')], VERIFIER_OFF);
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.resolver, 'email_finder');
  });

  it('skips a disabled provider and falls through to scrape', async () => {
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape(['jane.doe@acme.co']), [
      fakeProvider('should-not-be-used@acme.co', false),
    ]);
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.resolver, 'scrape');
  });
});

describe('resolveEmail verifier gate', () => {
  it('keeps a finder hit as verified when the verifier confirms it', async () => {
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape([]),
      [fakeProvider('jane.doe@acme.co')], fakeVerifier('verified'));
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.emailStatus, 'verified');
    assert.equal(r.resolver, 'verifier');
  });

  it('downgrades a catch-all/unknown domain to likely', async () => {
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape([]),
      [fakeProvider('jane.doe@acme.co')], fakeVerifier('likely'));
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.emailStatus, 'likely');
    assert.equal(r.resolver, 'verifier');
  });

  it('discards an invalid finder hit and continues the cascade to scrape', async () => {
    // Finder returns an address the verifier rejects; a real scraped email for
    // the same person must take over instead of shipping the invalid hit.
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape(['jane.doe@acme.co']),
      [fakeProvider('stale@acme.co')], fakeVerifier('invalid'));
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.resolver, 'scrape');
  });

  it('discards an invalid finder hit with no scrape fallback → null/none', async () => {
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape([]),
      [fakeProvider('stale@acme.co')], fakeVerifier('invalid'));
    assert.equal(r.email, null);
    assert.equal(r.emailStatus, 'none');
    assert.equal(r.resolver, 'none');
  });

  it('trusts the finder (verified/email_finder) when the verifier is off', async () => {
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape([]),
      [fakeProvider('jane.doe@acme.co')], VERIFIER_OFF);
    assert.equal(r.emailStatus, 'verified');
    assert.equal(r.resolver, 'email_finder');
  });
});
