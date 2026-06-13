import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmail, type EmailProvider, type ContactEmailFields } from './email-resolver';
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

describe('resolveEmail cascade', () => {
  it('returns a verified email from the finder before consulting scrape', async () => {
    // Scrape would also match here; the finder must win because it runs first.
    const r = await resolveEmail('Jane Doe', 'acme.co', NO_EMAIL, scrape(['jane.doe@acme.co']), [
      fakeProvider('jane.doe@acme.co'),
    ]);
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
    const r = await resolveEmail('Jane Doe', 'acme.co', existing, scrape([]), [fakeProvider('jane.doe@acme.co')]);
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
