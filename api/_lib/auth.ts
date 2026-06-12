// Firebase Auth JWT verification.
// Replaces the old Supabase `admin.auth.getUser(token)` flow.

import type { Request, Response } from 'express';
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { env } from './env';

let _app: App | null = null;

function firebaseApp(): App {
  if (_app) return _app;
  if (getApps().length) {
    _app = getApps()[0]!;
    return _app;
  }
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON();
  if (raw) {
    const credentials = JSON.parse(raw);
    _app = initializeApp({ credential: cert(credentials) });
  } else {
    // Falls back to GOOGLE_APPLICATION_CREDENTIALS env var (path to key file)
    // or to the metadata-server credentials when running on Cloud Run.
    _app = initializeApp();
  }
  return _app;
}

export interface AuthedUser {
  id: string;       // Firebase UID — used as `userId` on every Mongo doc.
  email: string | null;
}

// Server-side orchestration (the pipeline runner) needs to invoke an agent
// handler on behalf of an already-authenticated user without a Firebase token.
// It attaches the verified user under this symbol on a synthetic in-process
// request. A symbol key is unforgeable over the wire — it can't appear in JSON
// body, headers, or query — so a network client can never set it; only the
// internal invoker does. See api/_lib/internal-invoke.ts.
export const INTERNAL_USER = Symbol('internalUser');

export async function requireUser(req: Request, res: Response): Promise<AuthedUser | null> {
  const internal = (req as unknown as Record<symbol, AuthedUser | undefined>)[INTERNAL_USER];
  if (internal) return internal;

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_authorization' });
    return null;
  }
  const token = header.slice(7);
  try {
    const decoded = await getAuth(firebaseApp()).verifyIdToken(token);
    return { id: decoded.uid, email: decoded.email ?? null };
  } catch {
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
}

export function methodNotAllowed(res: Response, allow: string[]) {
  res.setHeader('Allow', allow.join(', '));
  res.status(405).json({ error: 'method_not_allowed' });
}

/**
 * Verify a shared-secret header for cron/task workers. Cloud Scheduler is
 * configured to send `Authorization: Bearer ${CRON_SECRET}`.
 */
export function requireCronSecret(req: Request, res: Response): boolean {
  const expected = env.CRON_SECRET();
  if (!expected) {
    res.status(500).json({ error: 'cron_secret_not_configured' });
    return false;
  }
  const got = req.headers.authorization?.replace(/^Bearer\s+/, '');
  if (got !== expected) {
    res.status(401).json({ error: 'invalid_cron_secret' });
    return false;
  }
  return true;
}
