// Regression tests for the SSRF guard on the public-web scraper and the email
// header-injection guard on outbound Gmail messages. Run with: npm test
//
// Background: `domain` flows from a user-writable target row into a server-side
// fetch (web-scrape.ts), and `to_override`/subject flow into RFC2822 headers
// (gmail.ts). Both are user-controllable, so both need input-side guards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidDomain, normalizeDomain } from './sender-context';
import { fetchPageText } from './web-scrape';
import { isValidEmailAddress } from './gmail';

// --- domain validation (defense-in-depth: reject IP literals + internal TLDs) ---
test('isValidDomain rejects IP literals and internal-only hosts', () => {
  for (const bad of [
    '169.254.169.254', // cloud metadata link-local
    '10.0.0.5',
    '192.168.1.1',
    '127.0.0.1',
    '172.16.5.5',
    '100.64.0.1',
    '0.0.0.0',
    'localhost',
    'foo.internal',
    'svc.local',
    'metadata.google.internal',
  ]) {
    assert.equal(isValidDomain(bad), false, `${bad} should be invalid`);
    assert.equal(normalizeDomain(bad), null, `${bad} should normalize to null`);
  }
});

test('isValidDomain still accepts real company domains', () => {
  for (const good of ['acme.co', 'sierra.ai', 'example.com', 'sub.example.org']) {
    assert.equal(isValidDomain(good), true, `${good} should be valid`);
  }
});

// --- connection-time SSRF guard (authoritative) ---
test('fetchPageText refuses internal / non-http targets', async () => {
  for (const url of [
    'http://169.254.169.254/',
    'http://localhost/',
    'http://10.0.0.1/',
    'http://192.168.0.1/',
    'http://metadata.google.internal/',
    'http://[::1]/',
    'file:///etc/passwd',
    'gopher://127.0.0.1/',
  ]) {
    const r = await fetchPageText(url);
    assert.equal(r, null, `${url} must be blocked`);
  }
});

// --- email header (CRLF) injection guard ---
test('isValidEmailAddress rejects header-injection payloads', () => {
  for (const bad of [
    'user@example.com\r\nBcc: attacker@evil.com',
    'user@example.com\nCc: x@y.com',
    'a@b',
    'no-at-sign',
    'user name@example.com',
    'a@b.com,c@d.com',
    '"x"@example.com',
  ]) {
    assert.equal(isValidEmailAddress(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('isValidEmailAddress accepts normal addresses', () => {
  for (const good of ['user@example.com', 'jane.doe@acme.co', 'user+tag@sub.example.com']) {
    assert.equal(isValidEmailAddress(good), true, `${good} should be accepted`);
  }
});
