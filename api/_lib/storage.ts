// Google Cloud Storage — replaces Supabase Storage for profile_assets
// (resumes, portfolio PDFs, case studies, screenshots).

import { Storage } from '@google-cloud/storage';
import { env } from './env';

let _storage: Storage | null = null;

function client(): Storage {
  if (_storage) return _storage;
  _storage = new Storage({ projectId: env.GCP_PROJECT_ID() });
  return _storage;
}

function bucket() {
  return client().bucket(env.GCS_BUCKET());
}

/**
 * Upload bytes for a user. Path convention: `users/{uid}/{kind}/{filename}`.
 * Returns the storage path (NOT a URL — frontend always pulls via signed URL).
 */
export async function uploadObject(args: {
  uid: string;
  kind: 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot';
  fileName: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}): Promise<{ path: string }> {
  const safeName = args.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `users/${args.uid}/${args.kind}/${Date.now()}_${safeName}`;
  const file = bucket().file(path);
  await file.save(args.body, {
    contentType: args.contentType,
    resumable: false,
    metadata: { metadata: { uid: args.uid, kind: args.kind } },
  });
  return { path };
}

export async function downloadObject(path: string): Promise<Buffer> {
  const [buf] = await bucket().file(path).download();
  return buf;
}

export async function deleteObject(path: string): Promise<void> {
  await bucket().file(path).delete({ ignoreNotFound: true });
}

export async function signedDownloadUrl(path: string, ttlSeconds = 600): Promise<string> {
  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + ttlSeconds * 1000,
  });
  return url;
}

/**
 * Signed URL for direct browser upload. Frontend PUTs bytes to this URL,
 * then calls our API to register the asset row in Mongo.
 */
export async function signedUploadUrl(args: {
  uid: string;
  kind: 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot';
  fileName: string;
  contentType: string;
  ttlSeconds?: number;
}): Promise<{ url: string; path: string }> {
  const safeName = args.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  const path = `users/${args.uid}/${args.kind}/${Date.now()}_${safeName}`;
  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: Date.now() + (args.ttlSeconds ?? 300) * 1000,
    contentType: args.contentType,
  });
  return { url, path };
}
