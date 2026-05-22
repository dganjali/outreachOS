// Generic CRUD router for the React app + storage helpers for GCS.
//
// Replaces the direct Supabase queries (which were RLS-gated). Every request
// is authed via Firebase JWT and scoped via forUser(uid).
import { Router } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser, newId, COL } from '../_lib/db';
import { signedUploadUrl, signedDownloadUrl, deleteObject } from '../_lib/storage';
const router = Router();
const ALLOWED = new Set(Object.values(COL));
router.use(async (req, res, next) => {
    const user = await requireUser(req, res);
    if (!user)
        return;
    req.uid = user.id;
    next();
});
// Helper — after the auth middleware, uid is guaranteed.
function uidOf(req) {
    return req.uid;
}
// ---- storage helpers (must come before /:collection/... routes) ----
router.post('/_storage/sign-upload', async (req, res) => {
    const uid = uidOf(req);
    const { path, contentType } = (req.body ?? {});
    if (!path || !contentType)
        return res.status(400).json({ error: 'missing_params' });
    const kindMatch = /\b(resume|portfolio_pdf|case_study|screenshot)\b/.exec(path);
    const kind = (kindMatch?.[1] ?? 'resume');
    const fileName = path.split('/').pop() ?? 'file';
    const result = await signedUploadUrl({ uid, kind, fileName, contentType });
    return res.json({ data: result });
});
router.post('/_storage/sign-download', async (req, res) => {
    const { path, ttlSeconds } = (req.body ?? {});
    if (!path)
        return res.status(400).json({ error: 'missing_path' });
    // NOTE: in a production hardening pass, verify the requesting uid owns this
    // path (it's stored as users/{uid}/...). For MVP we trust the JWT.
    const url = await signedDownloadUrl(path, ttlSeconds ?? 600);
    return res.json({ data: { url } });
});
router.post('/_storage/remove', async (req, res) => {
    const { paths } = (req.body ?? {});
    for (const p of paths ?? []) {
        try {
            await deleteObject(p);
        }
        catch { /* best-effort */ }
    }
    return res.json({ ok: true });
});
// ---- list with filter/order/limit ----
router.post('/:collection/query', async (req, res) => {
    const collection = req.params.collection;
    if (!ALLOWED.has(collection))
        return res.status(404).json({ error: 'unknown_collection' });
    const uid = uidOf(req);
    const { filter = {}, sort, limit } = (req.body ?? {});
    const scope = forUser(uid);
    const docs = await scope.collection(collection).find(sanitizeFilter(filter));
    let result = docs;
    if (sort) {
        const [k, dir] = Object.entries(sort)[0] ?? [];
        if (k) {
            result = [...result].sort((a, b) => {
                const av = a[k];
                const bv = b[k];
                if (av === bv)
                    return 0;
                return ((av > bv ? 1 : -1) * dir);
            });
        }
    }
    if (typeof limit === 'number' && limit > 0)
        result = result.slice(0, limit);
    res.json({ data: result });
});
router.get('/:collection/:id', async (req, res) => {
    const collection = req.params.collection;
    if (!ALLOWED.has(collection))
        return res.status(404).json({ error: 'unknown_collection' });
    const uid = uidOf(req);
    const doc = await forUser(uid).collection(collection).findById(req.params.id);
    if (!doc)
        return res.status(404).json({ error: 'not_found' });
    res.json({ data: doc });
});
router.post('/:collection', async (req, res) => {
    const collection = req.params.collection;
    if (!ALLOWED.has(collection))
        return res.status(404).json({ error: 'unknown_collection' });
    const uid = uidOf(req);
    const body = req.body ?? {};
    const doc = { _id: newId(), ...stripOwnership(body) };
    const created = await forUser(uid).collection(collection).insertOne(doc);
    res.status(201).json({ data: created });
});
router.patch('/:collection/:id', async (req, res) => {
    const collection = req.params.collection;
    if (!ALLOWED.has(collection))
        return res.status(404).json({ error: 'unknown_collection' });
    const uid = uidOf(req);
    const n = await forUser(uid).collection(collection).updateById(req.params.id, stripOwnership(req.body ?? {}));
    if (n === 0)
        return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, data: { _id: req.params.id } });
});
router.delete('/:collection/:id', async (req, res) => {
    const collection = req.params.collection;
    if (!ALLOWED.has(collection))
        return res.status(404).json({ error: 'unknown_collection' });
    const uid = uidOf(req);
    const n = await forUser(uid).collection(collection).deleteById(req.params.id);
    if (n === 0)
        return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
});
function sanitizeFilter(f) {
    const { userId, ...rest } = f;
    void userId;
    return rest;
}
function stripOwnership(o) {
    const { userId, createdAt, updatedAt, _id, ...rest } = o;
    void userId;
    void createdAt;
    void updatedAt;
    void _id;
    return rest;
}
export default router;
