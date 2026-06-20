// Generic CRUD router for the React app + storage helpers for GCS.
//
// Replaces the direct Supabase queries (which were RLS-gated). Every request
// is authed via Firebase JWT and scoped via forUser(uid).

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser, newId, COL, type CollectionName } from '../_lib/db';
import { signedUploadUrl, signedDownloadUrl, deleteObject } from '../_lib/storage';
import { assertSafeWriteBody, UnsafePayloadError } from '../_lib/sanitize';
import { checkMissionQuota, incrementMissionQuota } from '../_lib/runs';

// Module augmentation so `req.uid` is typed (set by the middleware below).
declare module 'express-serve-static-core' {
  interface Request {
    uid?: string;
  }
}

const router = Router();

const ALLOWED: ReadonlySet<string> = new Set(Object.values(COL));

router.use(async (req: Request, res: Response, next: NextFunction) => {
  const user = await requireUser(req, res);
  if (!user) return;
  req.uid = user.id;
  next();
});

// Helper - after the auth middleware, uid is guaranteed.
function uidOf(req: Request): string {
  return req.uid as string;
}

// ---- storage helpers (must come before /:collection/... routes) ----

router.post('/_storage/sign-upload', async (req, res) => {
  const uid = uidOf(req);
  const { path, contentType } = (req.body ?? {}) as { path?: string; contentType?: string };
  if (!path || !contentType) return res.status(400).json({ error: 'missing_params' });

  const kindMatch = /\b(resume|portfolio_pdf|case_study|screenshot|context_dump)\b/.exec(path);
  const kind = (kindMatch?.[1] ?? 'resume') as 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot' | 'context_dump';
  const fileName = path.split('/').pop() ?? 'file';

  const result = await signedUploadUrl({ uid, kind, fileName, contentType });
  return res.json({ data: result });
});

router.post('/_storage/sign-download', async (req, res) => {
  const uid = uidOf(req);
  const { path, ttlSeconds } = (req.body ?? {}) as { path?: string; ttlSeconds?: number };
  if (!path) return res.status(400).json({ error: 'missing_path' });
  // SHIPMENT_AUDIT.md S2 - only sign downloads for objects the caller owns.
  if (!ownsStoragePath(uid, path)) return res.status(403).json({ error: 'forbidden' });
  const url = await signedDownloadUrl(path, ttlSeconds ?? 600);
  return res.json({ data: { url } });
});

router.post('/_storage/remove', async (req, res) => {
  const uid = uidOf(req);
  const { paths } = (req.body ?? {}) as { paths?: string[] };
  const list = paths ?? [];
  // SHIPMENT_AUDIT.md S2 - fail closed: if any path isn't under the caller's
  // own users/{uid}/ prefix, reject the whole batch and delete nothing.
  if (!list.every((p) => ownsStoragePath(uid, p))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // Report how many objects actually deleted vs failed so the client can warn
  // instead of assuming success (the UI previously always saw {ok:true}).
  let removed = 0;
  let failed = 0;
  await Promise.all(
    list.map(async (p) => {
      try {
        await deleteObject(p);
        removed += 1;
      } catch {
        failed += 1;
      }
    }),
  );
  return res.json({ ok: failed === 0, removed, failed });
});

// ---- mission delete with cascade ----
// A mission owns targets, contacts, evidence, sequences, sent messages,
// replies, and agent runs (all carry a denormalized missionId). Deleting just
// the mission doc would orphan all of that, so hard-delete the dependents
// first. Registered before the generic '/:collection/:id' DELETE so it wins for
// missions; everything is scoped to the caller via forUser(uid).
const MISSION_CHILDREN: CollectionName[] = [
  COL.targets,
  COL.contacts,
  COL.evidencePacks,
  COL.emailSequences,
  COL.sentMessages,
  COL.replies,
  COL.agentRuns,
];

router.delete('/missions/:id', async (req, res) => {
  const uid = uidOf(req);
  const scope = forUser(uid);
  const missionId = req.params.id;

  const mission = await scope.collection(COL.missions).findById(missionId);
  if (!mission) return res.status(404).json({ error: 'not_found' });

  // The child collections are independent - delete them concurrently rather
  // than awaiting each in series (7 round-trips -> 1 round-trip of latency).
  const counts = await Promise.all(
    MISSION_CHILDREN.map((child) => scope.collection(child).deleteMany({ missionId } as any)),
  );
  const deleted: Record<string, number> = {};
  MISSION_CHILDREN.forEach((child, i) => {
    deleted[child] = counts[i];
  });
  await scope.collection(COL.missions).deleteById(missionId);

  res.json({ ok: true, deleted });
});

// ---- list with filter/order/limit ----
router.post('/:collection/query', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });

  const uid = uidOf(req);
  const { filter = {}, sort, limit, projection, count } = (req.body ?? {}) as {
    filter?: Record<string, unknown>;
    sort?: Record<string, 1 | -1>;
    limit?: number;
    projection?: Record<string, 0 | 1>;
    count?: boolean;
  };

  let safeFilter: Record<string, unknown>;
  try {
    safeFilter = sanitizeFilter(filter);
  } catch (err) {
    if (err instanceof InvalidFilterError) return res.status(400).json({ error: 'invalid_filter' });
    throw err;
  }

  const scope = forUser(uid);
  const col = scope.collection(collection as CollectionName);

  // Pure count (Dashboard cards): run countDocuments() server-side instead of
  // shipping every matching doc to the client just to take .length.
  if (count === true) {
    const n = await col.countDocuments(safeFilter as any);
    return res.json({ data: [], count: n });
  }

  // Push sort / limit / projection down to Mongo (was sorted+sliced in app
  // memory after fetching the whole collection).
  const docs = await col.find(safeFilter as any, {
    sort: safeSort(sort),
    limit: typeof limit === 'number' && limit > 0 ? limit : undefined,
    projection: safeProjection(projection),
  });
  res.json({ data: docs, count: docs.length });
});

// Sort/projection keys come from the client. They're field names, never
// operators - reject any `$`-prefixed key and coerce values to the small set
// Mongo accepts so a malformed spec can't reach the driver.
function safeSort(sort?: Record<string, unknown>): Record<string, 1 | -1> | undefined {
  if (!sort || typeof sort !== 'object') return undefined;
  const out: Record<string, 1 | -1> = {};
  for (const [k, v] of Object.entries(sort)) {
    if (k.startsWith('$')) continue;
    out[k] = v === -1 || v === '-1' ? -1 : 1;
  }
  return Object.keys(out).length ? out : undefined;
}

function safeProjection(projection?: Record<string, unknown>): Record<string, 0 | 1> | undefined {
  if (!projection || typeof projection !== 'object') return undefined;
  const out: Record<string, 0 | 1> = {};
  for (const [k, v] of Object.entries(projection)) {
    if (k.startsWith('$')) continue;
    out[k] = v ? 1 : 0;
  }
  return Object.keys(out).length ? out : undefined;
}

router.get('/:collection/:id', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });
  const uid = uidOf(req);
  const doc = await forUser(uid).collection(collection as CollectionName).findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'not_found' });
  res.json({ data: doc });
});

router.post('/:collection', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });
  const uid = uidOf(req);
  const body = req.body ?? {};
  try {
    assertSafeWriteBody(body);
  } catch (err) {
    if (err instanceof UnsafePayloadError) return res.status(400).json({ error: 'invalid_payload', detail: err.message });
    throw err;
  }
  const scope = forUser(uid);
  // Monthly mission-launch cap (delete-proof; see api/_lib/runs.ts). 429s with
  // mission_quota_exceeded when the caller is at their plan limit.
  if (collection === COL.missions && !(await checkMissionQuota(scope, res))) return;
  const doc = { _id: newId(), ...stripOwnership(body) };
  const created = await scope.collection(collection as CollectionName).insertOne(doc as any);
  // Count the launch only after a successful insert so a failed create doesn't
  // burn quota. The counter is monotonic - deletes never refund it.
  if (collection === COL.missions) await incrementMissionQuota(scope);
  res.status(201).json({ data: created });
});

router.patch('/:collection/:id', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });
  const uid = uidOf(req);
  const body = req.body ?? {};
  try {
    assertSafeWriteBody(body);
  } catch (err) {
    if (err instanceof UnsafePayloadError) return res.status(400).json({ error: 'invalid_payload', detail: err.message });
    throw err;
  }
  const n = await forUser(uid).collection(collection as CollectionName).updateById(req.params.id, stripOwnership(body));
  if (n === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, data: { _id: req.params.id } });
});

router.delete('/:collection/:id', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });
  const uid = uidOf(req);
  const n = await forUser(uid).collection(collection as CollectionName).deleteById(req.params.id);
  if (n === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Filter sanitization - SHIPMENT_AUDIT.md finding S1 (NoSQL operator injection).
//
// The frontend shim (src/lib/db.ts `deepKeyMap`) deliberately preserves
// `$`-prefixed keys, so client-supplied Mongo query operators survive the trip
// to the server. Ownership is injected server-side by forUser(uid).find(),
// which ANDs `userId: uid` at the top level - so this is NOT a cross-tenant
// read. But an unrestricted operator set still lets a caller run `$where`
// (arbitrary JS → CPU DoS) or `$regex` (ReDoS) within their own data scope.
//
// Defense: allow only an explicit, minimal set of comparison operators and
// reject everything else with a 400 (so bugs surface instead of silently
// dropping). The allowlist is exactly what the Query builder in src/lib/db.ts
// emits ($in, $ne, $gte) plus the obvious safe siblings. No $where / $expr /
// $function / $accumulator / $regex - none are used by any caller.
const ALLOWED_OPERATORS: ReadonlySet<string> = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
]);

/** Thrown for a disallowed operator; the /query route maps it to HTTP 400. */
export class InvalidFilterError extends Error {
  constructor(message = 'invalid_filter') {
    super(message);
    this.name = 'InvalidFilterError';
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/**
 * Drop the client-supplied `userId` (ownership is injected server-side and must
 * never be client-controllable) and validate that every Mongo operator in the
 * filter is on the allowlist. Throws InvalidFilterError on any disallowed key.
 */
export function sanitizeFilter(f: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(f)) throw new InvalidFilterError();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    // Ownership is server-injected; any client value here is ignored.
    if (key === 'userId') continue;
    // A real field name never starts with '$'. A top-level operator
    // ($where, $or, $expr, ...) is an injection vector - reject it.
    if (key.startsWith('$')) throw new InvalidFilterError();
    out[key] = sanitizeValue(value);
  }
  return out;
}

/**
 * Validate a single field's value, recursing one level. A value is one of:
 *  - primitive / array / null  → plain equality, always safe;
 *  - operator object ({ $gte: 5 }) → every key must be an allowed operator;
 *  - sub-document ({ city: 'NYC' }) → no operators, plain equality.
 * Mixing operators with plain keys ({ $gte: 5, city: 'NYC' }) is rejected, as
 * Mongo does not permit it at the same level anyway.
 */
function sanitizeValue(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  const hasOperator = keys.some((k) => k.startsWith('$'));
  if (!hasOperator) return value; // sub-document equality - no operators present
  for (const k of keys) {
    if (!k.startsWith('$')) throw new InvalidFilterError(); // operator/field mix
    if (!ALLOWED_OPERATORS.has(k)) throw new InvalidFilterError();
  }
  return value;
}

function stripOwnership<T extends object>(o: T): T {
  const { userId, createdAt, updatedAt, _id, ...rest } = o as Record<string, unknown>;
  void userId; void createdAt; void updatedAt; void _id;
  return rest as T;
}

// ---------------------------------------------------------------------------
// Storage path ownership - SHIPMENT_AUDIT.md finding S2 (IDOR on signed
// downloads / deletes).
//
// Objects live at `users/{uid}/{kind}/{filename}` (see api/_lib/storage.ts).
// The sign-download and remove handlers take a client-supplied `path` and hand
// it straight to GCS, so without an ownership check any authed user who learns
// or guesses another user's path gets a working signed URL (or deletes their
// file). Both handlers gate on this predicate using the authenticated uid.
//
// Strict by construction so traversal / encoding tricks can't smuggle a path
// out of the caller's prefix. Real paths (storage.ts) only ever contain
// [A-Za-z0-9._/-] - the upload helper maps /[^A-Za-z0-9._-]/g -> '_' and
// prefixes a timestamp - so none of the characters/segments rejected below can
// appear in a legitimate path (no false positives).
export function ownsStoragePath(uid: string, path: string): boolean {
  if (typeof uid !== 'string' || uid.length === 0) return false;
  if (typeof path !== 'string' || path.length === 0) return false;
  // We compare the raw string against the raw prefix, so reject anything a
  // downstream layer might decode to '/' or '.' (e.g. %2e%2e, %2f, '\').
  if (path.includes('%') || path.includes('\\')) return false;
  // Must sit exactly under this user's prefix (trailing slash stops
  // `users/{uid}` from also matching `users/{uid}extra/...`).
  if (!path.startsWith(`users/${uid}/`)) return false;
  // No traversal ('..') or current-dir ('.') segment anywhere in the path.
  for (const segment of path.split('/')) {
    if (segment === '..' || segment === '.') return false;
  }
  return true;
}

export default router;
