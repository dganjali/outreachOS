// Generic CRUD router for the React app + storage helpers for GCS.
//
// Replaces the direct Supabase queries (which were RLS-gated). Every request
// is authed via Firebase JWT and scoped via forUser(uid).

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser, newId, COL, type CollectionName } from '../_lib/db';
import { signedUploadUrl, signedDownloadUrl, deleteObject } from '../_lib/storage';

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

// Helper — after the auth middleware, uid is guaranteed.
function uidOf(req: Request): string {
  return req.uid as string;
}

// ---- storage helpers (must come before /:collection/... routes) ----

router.post('/_storage/sign-upload', async (req, res) => {
  const uid = uidOf(req);
  const { path, contentType } = (req.body ?? {}) as { path?: string; contentType?: string };
  if (!path || !contentType) return res.status(400).json({ error: 'missing_params' });

  const kindMatch = /\b(resume|portfolio_pdf|case_study|screenshot)\b/.exec(path);
  const kind = (kindMatch?.[1] ?? 'resume') as 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot';
  const fileName = path.split('/').pop() ?? 'file';

  const result = await signedUploadUrl({ uid, kind, fileName, contentType });
  return res.json({ data: result });
});

router.post('/_storage/sign-download', async (req, res) => {
  const uid = uidOf(req);
  const { path, ttlSeconds } = (req.body ?? {}) as { path?: string; ttlSeconds?: number };
  if (!path) return res.status(400).json({ error: 'missing_path' });
  // SHIPMENT_AUDIT.md S2 — only sign downloads for objects the caller owns.
  if (!ownsStoragePath(uid, path)) return res.status(403).json({ error: 'forbidden' });
  const url = await signedDownloadUrl(path, ttlSeconds ?? 600);
  return res.json({ data: { url } });
});

router.post('/_storage/remove', async (req, res) => {
  const uid = uidOf(req);
  const { paths } = (req.body ?? {}) as { paths?: string[] };
  const list = paths ?? [];
  // SHIPMENT_AUDIT.md S2 — fail closed: if any path isn't under the caller's
  // own users/{uid}/ prefix, reject the whole batch and delete nothing.
  if (!list.every((p) => ownsStoragePath(uid, p))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  for (const p of list) {
    try { await deleteObject(p); } catch { /* best-effort */ }
  }
  return res.json({ ok: true });
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

  const deleted: Record<string, number> = {};
  for (const child of MISSION_CHILDREN) {
    deleted[child] = await scope.collection(child).deleteMany({ missionId } as any);
  }
  await scope.collection(COL.missions).deleteById(missionId);

  res.json({ ok: true, deleted });
});

// ---- list with filter/order/limit ----
router.post('/:collection/query', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });

  const uid = uidOf(req);
  const { filter = {}, sort, limit } = (req.body ?? {}) as {
    filter?: Record<string, unknown>;
    sort?: Record<string, 1 | -1>;
    limit?: number;
  };

  let safeFilter: Record<string, unknown>;
  try {
    safeFilter = sanitizeFilter(filter);
  } catch (err) {
    if (err instanceof InvalidFilterError) return res.status(400).json({ error: 'invalid_filter' });
    throw err;
  }

  const scope = forUser(uid);
  const docs = await scope.collection(collection as CollectionName).find(safeFilter);
  let result = docs;
  if (sort) {
    const [k, dir] = Object.entries(sort)[0] ?? [];
    if (k) {
      result = [...result].sort((a, b) => {
        const av = (a as any)[k];
        const bv = (b as any)[k];
        if (av === bv) return 0;
        return ((av > bv ? 1 : -1) * (dir as 1 | -1)) as number;
      });
    }
  }
  if (typeof limit === 'number' && limit > 0) result = result.slice(0, limit);
  res.json({ data: result });
});

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
  const doc = { _id: newId(), ...stripOwnership(body) };
  const created = await forUser(uid).collection(collection as CollectionName).insertOne(doc as any);
  res.status(201).json({ data: created });
});

router.patch('/:collection/:id', async (req, res) => {
  const collection = req.params.collection;
  if (!ALLOWED.has(collection)) return res.status(404).json({ error: 'unknown_collection' });
  const uid = uidOf(req);
  const n = await forUser(uid).collection(collection as CollectionName).updateById(req.params.id, stripOwnership(req.body ?? {}));
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
// Filter sanitization — SHIPMENT_AUDIT.md finding S1 (NoSQL operator injection).
//
// The frontend shim (src/lib/db.ts `deepKeyMap`) deliberately preserves
// `$`-prefixed keys, so client-supplied Mongo query operators survive the trip
// to the server. Ownership is injected server-side by forUser(uid).find(),
// which ANDs `userId: uid` at the top level — so this is NOT a cross-tenant
// read. But an unrestricted operator set still lets a caller run `$where`
// (arbitrary JS → CPU DoS) or `$regex` (ReDoS) within their own data scope.
//
// Defense: allow only an explicit, minimal set of comparison operators and
// reject everything else with a 400 (so bugs surface instead of silently
// dropping). The allowlist is exactly what the Query builder in src/lib/db.ts
// emits ($in, $ne, $gte) plus the obvious safe siblings. No $where / $expr /
// $function / $accumulator / $regex — none are used by any caller.
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
    // ($where, $or, $expr, ...) is an injection vector — reject it.
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
  if (!hasOperator) return value; // sub-document equality — no operators present
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
// Storage path ownership — SHIPMENT_AUDIT.md finding S2 (IDOR on signed
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
// [A-Za-z0-9._/-] — the upload helper maps /[^A-Za-z0-9._-]/g -> '_' and
// prefixes a timestamp — so none of the characters/segments rejected below can
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
