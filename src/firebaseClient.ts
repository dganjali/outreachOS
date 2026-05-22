// Firebase client SDK init. Replaces src/supabaseClient.ts.
//
// This module exports `auth` (Firebase Auth instance) for the AuthContext to
// use, and a `currentIdToken()` helper that other code uses to attach the
// JWT to API requests.

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

if (!cfg.apiKey || !cfg.authDomain || !cfg.projectId || !cfg.appId) {
  throw new Error(
    'Missing Firebase environment variables (VITE_FIREBASE_API_KEY / _AUTH_DOMAIN / _PROJECT_ID / _APP_ID).'
  );
}

const app: FirebaseApp = initializeApp({
  apiKey: cfg.apiKey,
  authDomain: cfg.authDomain,
  projectId: cfg.projectId,
  appId: cfg.appId,
});

export const auth: Auth = getAuth(app);

/** Get the current user's ID token, or null if signed out. */
export async function currentIdToken(): Promise<string | null> {
  const u = auth.currentUser;
  if (!u) return null;
  return await u.getIdToken(/* forceRefresh */ false);
}
