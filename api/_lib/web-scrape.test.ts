import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractEmailsFromHtml,
  inferEmailPattern,
  emailFromPattern,
  matchEmailForPerson,
} from './web-scrape';

describe('extractEmailsFromHtml', () => {
  it('pulls mailto and inline emails on the company domain', () => {
    const html = `
      <a href="mailto:jane.doe@acme.co">Jane</a>
      <p>Reach us at hiring@acme.co or spam@other.com</p>
    `;
    const emails = extractEmailsFromHtml(html, 'acme.co');
    assert.deepEqual(emails.sort(), ['hiring@acme.co', 'jane.doe@acme.co']);
  });
});

describe('inferEmailPattern', () => {
  it('detects first.last pattern', () => {
    assert.equal(
      inferEmailPattern(['jane.doe@acme.co', 'john.smith@acme.co']),
      'first.last'
    );
  });
});

describe('matchEmailForPerson', () => {
  it('matches scraped email to contact name', () => {
    const r = matchEmailForPerson('Jane Doe', ['jane.doe@acme.co', 'info@acme.co'], 'acme.co');
    assert.equal(r.email, 'jane.doe@acme.co');
    assert.equal(r.status, 'verified');
  });

  it('guesses from pattern when no direct match', () => {
    const r = matchEmailForPerson(
      'John Smith',
      ['jane.doe@acme.co', 'bob.jones@acme.co'],
      'acme.co'
    );
    assert.equal(r.email, 'john.smith@acme.co');
    assert.equal(r.status, 'likely');
  });
});

describe('emailFromPattern', () => {
  it('builds first.last address', () => {
    assert.equal(emailFromPattern('first.last', 'John Smith', 'acme.co'), 'john.smith@acme.co');
  });
});
