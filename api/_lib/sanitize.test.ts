// Unit tests for write-body sanitization (prototype pollution, stored Mongo
// operators / dotted keys, depth & size bounds). Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeWriteBody, UnsafePayloadError } from './sanitize';

test('accepts ordinary documents', () => {
  assert.doesNotThrow(() =>
    assertSafeWriteBody({ name: 'Ada', tags: ['a', 'b'], meta: { score: 9, when: new Date() } }),
  );
  assert.doesNotThrow(() => assertSafeWriteBody({ nested: { deep: { ok: true } } }));
  assert.doesNotThrow(() => assertSafeWriteBody([{ a: 1 }, { b: 2 }]));
});

test('rejects prototype-pollution keys at any depth', () => {
  // `__proto__` must come from JSON *text* — an object literal would set the
  // prototype instead of an own key. JSON.parse makes it an own enumerable key,
  // which is exactly the pollution vector we defend against.
  for (const json of [
    '{"__proto__": {"isAdmin": true}}',
    '{"a": {"b": {"constructor": {"x": 1}}}}',
    '{"nested": {"prototype": 1}}',
  ]) {
    assert.throws(() => assertSafeWriteBody(JSON.parse(json)), UnsafePayloadError, json);
  }
});

test('rejects stored Mongo operators and dotted paths', () => {
  assert.throws(() => assertSafeWriteBody({ $set: { x: 1 } }), UnsafePayloadError);
  assert.throws(() => assertSafeWriteBody({ 'a.b': 1 }), UnsafePayloadError);
  assert.throws(() => assertSafeWriteBody({ nested: { $inc: 1 } }), UnsafePayloadError);
});

test('enforces depth, key-count, and string-length bounds', () => {
  // Too deep.
  let deep: Record<string, unknown> = { v: 1 };
  for (let i = 0; i < 20; i++) deep = { d: deep };
  assert.throws(() => assertSafeWriteBody(deep, { maxDepth: 12 }), UnsafePayloadError);

  // Too many keys.
  const wide: Record<string, number> = {};
  for (let i = 0; i < 50; i++) wide[`k${i}`] = i;
  assert.throws(() => assertSafeWriteBody(wide, { maxKeys: 10 }), UnsafePayloadError);

  // Oversized string.
  assert.throws(
    () => assertSafeWriteBody({ blob: 'x'.repeat(2000) }, { maxStringLength: 1000 }),
    UnsafePayloadError,
  );
});

test('primitives and empty containers are safe', () => {
  assert.doesNotThrow(() => assertSafeWriteBody(null));
  assert.doesNotThrow(() => assertSafeWriteBody('hello'));
  assert.doesNotThrow(() => assertSafeWriteBody(42));
  assert.doesNotThrow(() => assertSafeWriteBody({}));
  assert.doesNotThrow(() => assertSafeWriteBody([]));
});
