// Object storage for profile_assets (resumes, portfolio PDFs, case studies,
// screenshots, context dumps).
//
// Two drivers:
//   - 'gcs'   - Google Cloud Storage. Browser uploads/downloads go DIRECTLY to
//               GCS via v4 signed URLs (no bytes through our Node server). Prod.
//   - 'local' - filesystem under LOCAL_STORAGE_DIR, served by our own HMAC-token
//               put/get endpoints. The "signed URL" is a relative path to those
//               endpoints, so the frontend storage shim is driver-agnostic.
//
// Why local exists: dev has no real GCS bucket (GCS_BUCKET is a placeholder), so
// the direct browser PUT to GCS fails with "Failed to fetch". The local driver
// makes uploads work with zero cloud setup. Selection: STORAGE_DRIVER wins;
// otherwise fall back to local whenever GCS_BUCKET is empty or a placeholder.

import { Storage } from '@google-cloud/storage';
import { createHmac, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Request, Response } from 'express';
import { env } from './env';

type Kind = 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot' | 'context_dump';
type Action = 'read' | 'write';

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------
function useLocal(): boolean {
  const driver = process.env.STORAGE_DRIVER;
  if (driver === 'local') return true;
  if (driver === 'gcs') return false;
  const bucketName = process.env.GCS_BUCKET ?? '';
  return !bucketName || /placeholder/i.test(bucketName);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function objectPath(uid: string, kind: Kind, fileName: string): string {
  const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return `users/${uid}/${kind}/${Date.now()}_${safeName}`;
}

// ---------------------------------------------------------------------------
// GCS driver
// ---------------------------------------------------------------------------
let _storage: Storage | null = null;
function client(): Storage {
  if (_storage) return _storage;
  _storage = new Storage({ projectId: env.GCP_PROJECT_ID() });
  return _storage;
}
function bucket() {
  return client().bucket(env.GCS_BUCKET());
}

// ---------------------------------------------------------------------------
// Local-filesystem driver
// ---------------------------------------------------------------------------
const LOCAL_DIR = process.env.LOCAL_STORAGE_DIR || path.join(os.tmpdir(), 'outreachos-uploads');

function signingSecret(): string {
  // Local driver is dev-only; a stable default is fine when none is set.
  return process.env.STORAGE_SIGNING_SECRET || 'outreachos-local-dev-storage-secret';
}

function makeToken(p: string, action: Action, ttlSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ p, a: action, e: Date.now() + ttlSeconds * 1000 })).toString('base64url');
  const sig = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Returns the storage path the token authorizes, or null if invalid/expired. */
function verifyToken(token: string, action: Action): string | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', signingSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { p, a: act, e } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { p: string; a: Action; e: number };
    if (act !== action || Date.now() > e) return null;
    return p;
  } catch {
    return null;
  }
}

/** Resolve a storage path to an absolute on-disk path, guarding against traversal. */
function localPathFor(storagePath: string): string {
  const root = path.resolve(LOCAL_DIR);
  const full = path.resolve(root, storagePath);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('invalid_path');
  return full;
}

// ---------------------------------------------------------------------------
// Public API - each branches on the active driver
// ---------------------------------------------------------------------------

/**
 * Upload bytes for a user (server-side path; agents that generate assets).
 * Path convention: `users/{uid}/{kind}/{filename}`. Returns the storage path.
 */
export async function uploadObject(args: {
  uid: string;
  kind: Kind;
  fileName: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}): Promise<{ path: string }> {
  const p = objectPath(args.uid, args.kind, args.fileName);
  if (useLocal()) {
    const full = localPathFor(p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, args.body);
    return { path: p };
  }
  await bucket().file(p).save(args.body, {
    contentType: args.contentType,
    resumable: false,
    metadata: { metadata: { uid: args.uid, kind: args.kind } },
  });
  return { path: p };
}

export async function downloadObject(storagePath: string): Promise<Buffer> {
  if (useLocal()) return fs.readFile(localPathFor(storagePath));
  const [buf] = await bucket().file(storagePath).download();
  return buf;
}

export async function deleteObject(storagePath: string): Promise<void> {
  if (useLocal()) {
    await fs.rm(localPathFor(storagePath), { force: true });
    return;
  }
  await bucket().file(storagePath).delete({ ignoreNotFound: true });
}

export async function signedDownloadUrl(storagePath: string, ttlSeconds = 600): Promise<string> {
  if (useLocal()) {
    const token = makeToken(storagePath, 'read', ttlSeconds);
    return `/api/storage-local/get?token=${encodeURIComponent(token)}`;
  }
  const [url] = await bucket().file(storagePath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + ttlSeconds * 1000,
  });
  return url;
}

/**
 * URL the browser PUTs bytes to. GCS → a v4 signed URL straight to the bucket.
 * Local → a relative path to our token-authed put endpoint (resolved against the
 * app origin, so the frontend storage shim needs no driver awareness).
 */
export async function signedUploadUrl(args: {
  uid: string;
  kind: Kind;
  fileName: string;
  contentType: string;
  ttlSeconds?: number;
}): Promise<{ url: string; path: string }> {
  const p = objectPath(args.uid, args.kind, args.fileName);
  const ttl = args.ttlSeconds ?? 300;
  if (useLocal()) {
    const token = makeToken(p, 'write', ttl);
    return { url: `/api/storage-local/put?token=${encodeURIComponent(token)}`, path: p };
  }
  const [url] = await bucket().file(p).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + ttl * 1000,
    contentType: args.contentType,
  });
  return { url, path: p };
}

// ---------------------------------------------------------------------------
// Local-driver HTTP handlers - mounted in server/index.ts at /api/storage-local.
// They authenticate via the HMAC token in the query string (NOT a Firebase
// bearer), mirroring how GCS signed URLs are origin-independent. Registered with
// express.raw so the PUT body arrives as a Buffer.
// ---------------------------------------------------------------------------
export async function localPutHandler(req: Request, res: Response): Promise<void> {
  const token = String(req.query.token ?? '');
  const storagePath = verifyToken(token, 'write');
  if (!storagePath) {
    res.status(403).json({ error: 'invalid_or_expired_token' });
    return;
  }
  const body = req.body as Buffer;
  if (!Buffer.isBuffer(body)) {
    res.status(400).json({ error: 'expected_raw_body' });
    return;
  }
  const full = localPathFor(storagePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
  res.status(200).json({ ok: true, path: storagePath });
}

export async function localGetHandler(req: Request, res: Response): Promise<void> {
  const token = String(req.query.token ?? '');
  const storagePath = verifyToken(token, 'read');
  if (!storagePath) {
    res.status(403).json({ error: 'invalid_or_expired_token' });
    return;
  }
  try {
    const buf = await fs.readFile(localPathFor(storagePath));
    res.status(200).send(buf);
  } catch {
    res.status(404).json({ error: 'not_found' });
  }
}
