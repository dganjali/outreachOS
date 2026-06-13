// Request-payload sanitization shared by the write endpoints.
//
// The data router already gates *query* filters against NoSQL-operator
// injection (see api/data/router.ts `sanitizeFilter`). This module covers the
// other half — the *write* path and request bodies generally — against three
// classes of malformed/abusive input:
//
//   1. Prototype pollution — JSON like {"__proto__": {"isAdmin": true}} parses
//      with `__proto__` as an OWN property; if such an object is later merged
//      into another via spread/Object.assign in a way that walks the prototype
//      chain, it can poison Object.prototype. We reject these keys outright.
//   2. Stored Mongo operators / dotted paths — a write body that reaches
//      `$set: { ...body }` with a key like `$rename` or `a.b` would mutate
//      fields the caller never intended. Real document fields never start with
//      `$` or contain `.`, so we reject them.
//   3. Oversized / pathologically-nested payloads — deeply nested or huge
//      objects are a cheap DoS. We bound depth and total key count.

export class UnsafePayloadError extends Error {
  constructor(message = 'unsafe_payload') {
    super(message);
    this.name = 'UnsafePayloadError';
  }
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const DEFAULT_MAX_DEPTH = 12;
const DEFAULT_MAX_KEYS = 2_000;
const DEFAULT_MAX_STRING = 100_000; // 100k chars per individual string field

export interface SanitizeOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxStringLength?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Deep-validate an arbitrary parsed-JSON value destined for storage. Throws
 * UnsafePayloadError on any prototype-pollution key, stored Mongo operator /
 * dotted key, or when depth / key-count / string-length bounds are exceeded.
 *
 * Returns the value unchanged when safe (it does not clone — callers store the
 * original object). The caller maps the thrown error to HTTP 400.
 */
export function assertSafeWriteBody(value: unknown, opts: SanitizeOptions = {}): void {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const maxString = opts.maxStringLength ?? DEFAULT_MAX_STRING;
  let keyBudget = maxKeys;

  function walk(node: unknown, depth: number): void {
    if (depth > maxDepth) throw new UnsafePayloadError('payload_too_deep');

    if (typeof node === 'string') {
      if (node.length > maxString) throw new UnsafePayloadError('string_too_long');
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        if (--keyBudget < 0) throw new UnsafePayloadError('too_many_keys');
        if (FORBIDDEN_KEYS.has(key)) throw new UnsafePayloadError('forbidden_key');
        // A real stored field never starts with `$` (Mongo operator) or
        // contains `.` (dotted update path).
        if (key.startsWith('$') || key.includes('.')) throw new UnsafePayloadError('illegal_key');
        walk((node as Record<string, unknown>)[key], depth + 1);
      }
      return;
    }
    // primitives (number, boolean, null, undefined) and Date are always safe.
  }

  walk(value, 0);
}

/**
 * Convenience wrapper for the data-router write paths: validates and returns the
 * same body, or throws UnsafePayloadError. Kept separate from
 * `assertSafeWriteBody` so call sites read as `const safe = sanitizeWriteBody(req.body)`.
 */
export function sanitizeWriteBody<T>(body: T, opts?: SanitizeOptions): T {
  assertSafeWriteBody(body, opts);
  return body;
}
