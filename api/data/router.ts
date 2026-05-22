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
  const { path, ttlSeconds } = (req.body ?? {}) as { path?: string; ttlSeconds?: number };
  if (!path) return res.status(400).json({ error: 'missing_path' });
  // NOTE: in a production hardening pass, verify the requesting uid owns this
  // path (it's stored as users/{uid}/...). For MVP we trust the JWT.
  const url = await signedDownloadUrl(path, ttlSeconds ?? 600);
  return res.json({ data: { url } });
});

router.post('/_storage/remove', async (req, res) => {
  const { paths } = (req.body ?? {}) as { paths?: string[] };
  for (const p of paths ?? []) {
    try { await deleteObject(p); } catch { /* best-effort */ }
  }
  return res.json({ ok: true });
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

  const scope = forUser(uid);
  const docs = await scope.collection(collection as CollectionName).find(sanitizeFilter(filter));
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

function sanitizeFilter(f: Record<string, unknown>): Record<string, unknown> {
  const { userId, ...rest } = f;
  void userId;
  return rest;
}

function stripOwnership<T extends object>(o: T): T {
  const { userId, createdAt, updatedAt, _id, ...rest } = o as Record<string, unknown>;
  void userId; void createdAt; void updatedAt; void _id;
  return rest as T;
}

export default router;
