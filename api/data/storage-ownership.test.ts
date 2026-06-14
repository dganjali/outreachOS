// Unit tests for the storage-path IDOR hardening on the signed-download and
// object-remove endpoints - SHIPMENT_AUDIT.md finding S2. Run with: npm test
//
// These exercise the security-critical predicate (ownsStoragePath) directly.
// The /_storage/sign-download and /_storage/remove routes call it with the
// authenticated uid (uidOf(req)) and reject a non-owned path with HTTP 403
// { error: 'forbidden' } before touching GCS. Objects are stored at
// `users/{uid}/{kind}/{filename}` (see api/_lib/storage.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsStoragePath } from './router';

const UID = 'alice123';

test("(a) a path under the caller's own users/{uid}/ prefix is allowed", () => {
  assert.equal(ownsStoragePath(UID, `users/${UID}/resume/1717000000_resume.pdf`), true);
  // Dots inside a filename segment are fine - only a bare `..` segment
  // traverses, and storage.ts can legitimately produce names like this.
  assert.equal(ownsStoragePath(UID, `users/${UID}/case_study/1717000000_my..notes.pdf`), true);
});

test('(b) a path under a different uid is rejected (the IDOR)', () => {
  assert.equal(ownsStoragePath(UID, 'users/bob456/resume/1717000000_resume.pdf'), false);
  // A uid that the caller's uid is a prefix of must not match - the trailing
  // slash in the required prefix guards this.
  assert.equal(ownsStoragePath(UID, `users/${UID}extra/resume/x.pdf`), false);
});

test('(c) traversal and encoding tricks cannot escape the prefix', () => {
  // `..` segment that climbs out of the caller's prefix into another user's.
  assert.equal(ownsStoragePath(UID, `users/${UID}/../bob456/resume/x.pdf`), false);
  // Bare `.` (current-dir) segment.
  assert.equal(ownsStoragePath(UID, `users/${UID}/./resume/x.pdf`), false);
  // Percent-encoded dots / separators that a downstream layer might decode.
  assert.equal(ownsStoragePath(UID, `users/${UID}/%2e%2e/bob456/x.pdf`), false);
  assert.equal(ownsStoragePath(UID, `users%2f${UID}/resume/x.pdf`), false);
  // Backslash separators.
  assert.equal(ownsStoragePath(UID, `users\\${UID}\\resume\\x.pdf`), false);
});

test('(d) malformed or non-prefixed paths are rejected', () => {
  assert.equal(ownsStoragePath(UID, ''), false);
  assert.equal(ownsStoragePath(UID, `/users/${UID}/resume/x.pdf`), false); // leading slash
  assert.equal(ownsStoragePath(UID, `other/${UID}/resume/x.pdf`), false);
  assert.equal(ownsStoragePath('', 'users//resume/x.pdf'), false); // empty uid
});
