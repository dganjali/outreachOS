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
    const uid = uidOf(req);
    const { path, ttlSeconds } = (req.body ?? {});
    if (!path)
        return res.status(400).json({ error: 'missing_path' });
    // SHIPMENT_AUDIT.md S2 — only sign downloads for objects the caller owns.
    if (!ownsStoragePath(uid, path))
        return res.status(403).json({ error: 'forbidden' });
    const url = await signedDownloadUrl(path, ttlSeconds ?? 600);
    return res.json({ data: { url } });
});
router.post('/_storage/remove', async (req, res) => {
    const uid = uidOf(req);
    const { paths } = (req.body ?? {});
    const list = paths ?? [];
    // SHIPMENT_AUDIT.md S2 — fail closed: if any path isn't under the caller's
    // own users/{uid}/ prefix, reject the whole batch and delete nothing.
    if (!list.every((p) => ownsStoragePath(uid, p))) {
        return res.status(403).json({ error: 'forbidden' });
    }
    for (const p of list) {
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
    let safeFilter;
    try {
        safeFilter = sanitizeFilter(filter);
    }
    catch (err) {
        if (err instanceof InvalidFilterError)
            return res.status(400).json({ error: 'invalid_filter' });
        throw err;
    }
    const scope = forUser(uid);
    const docs = await scope.collection(collection).find(safeFilter);
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
const ALLOWED_OPERATORS = new Set([
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
]);
/** Thrown for a disallowed operator; the /query route maps it to HTTP 400. */
export class InvalidFilterError extends Error {
    constructor(message = 'invalid_filter') {
        super(message);
        this.name = 'InvalidFilterError';
    }
}
function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}
/**
 * Drop the client-supplied `userId` (ownership is injected server-side and must
 * never be client-controllable) and validate that every Mongo operator in the
 * filter is on the allowlist. Throws InvalidFilterError on any disallowed key.
 */
export function sanitizeFilter(f) {
    if (!isPlainObject(f))
        throw new InvalidFilterError();
    const out = {};
    for (const [key, value] of Object.entries(f)) {
        // Ownership is server-injected; any client value here is ignored.
        if (key === 'userId')
            continue;
        // A real field name never starts with '$'. A top-level operator
        // ($where, $or, $expr, ...) is an injection vector — reject it.
        if (key.startsWith('$'))
            throw new InvalidFilterError();
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
function sanitizeValue(value) {
    if (!isPlainObject(value))
        return value;
    const keys = Object.keys(value);
    const hasOperator = keys.some((k) => k.startsWith('$'));
    if (!hasOperator)
        return value; // sub-document equality — no operators present
    for (const k of keys) {
        if (!k.startsWith('$'))
            throw new InvalidFilterError(); // operator/field mix
        if (!ALLOWED_OPERATORS.has(k))
            throw new InvalidFilterError();
    }
    return value;
}
function stripOwnership(o) {
    const { userId, createdAt, updatedAt, _id, ...rest } = o;
    void userId;
    void createdAt;
    void updatedAt;
    void _id;
    return rest;
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
export function ownsStoragePath(uid, path) {
    if (typeof uid !== 'string' || uid.length === 0)
        return false;
    if (typeof path !== 'string' || path.length === 0)
        return false;
    // We compare the raw string against the raw prefix, so reject anything a
    // downstream layer might decode to '/' or '.' (e.g. %2e%2e, %2f, '\').
    if (path.includes('%') || path.includes('\\'))
        return false;
    // Must sit exactly under this user's prefix (trailing slash stops
    // `users/{uid}` from also matching `users/{uid}extra/...`).
    if (!path.startsWith(`users/${uid}/`))
        return false;
    // No traversal ('..') or current-dir ('.') segment anywhere in the path.
    for (const segment of path.split('/')) {
        if (segment === '..' || segment === '.')
            return false;
    }
    return true;
}
export default router;
