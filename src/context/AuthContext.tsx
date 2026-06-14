// Firebase Auth replacement for the old Supabase auth context.
// API surface preserved: { session, user, profile, loading, signOut, refreshProfile }
// so pages don't all need to change. The exposed `user` object mimics
// Supabase's user shape — it has `id` and `email` (mapped from Firebase's
// `uid`/`email`), and the underlying Firebase user is kept as `firebaseUser`
// for anything that needs the SDK directly.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, signOut as fbSignOut, type User as FirebaseUser } from 'firebase/auth';
import { auth } from '../firebaseClient';
import { db } from '../lib/db';
import type { Profile } from '../types';

/**
 * Supabase-shaped user (frontend pages access `user.id`, `user.email`).
 * Backed by the Firebase user.
 */
export interface CompatUser {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  firebaseUser: FirebaseUser;
}

export interface SessionLike {
  user: CompatUser;
  access_token: string | null;
}

interface AuthContextValue {
  session: SessionLike | null;
  user: CompatUser | null;
  profile: Profile | null;
  loading: boolean;
  /** Firebase email-verified flag, kept reactive (reload() mutates in place). */
  emailVerified: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Re-fetch the Firebase user so a verification that happened elsewhere is
   *  picked up without a full page reload. Returns the fresh verified state. */
  reloadUser: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function compat(u: FirebaseUser): CompatUser {
  return {
    id: u.uid,
    email: u.email,
    email_confirmed_at: u.emailVerified ? new Date().toISOString() : null,
    firebaseUser: u,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  // Tracked as its own state because Firebase's `reload()` mutates the user
  // object in place (same reference), so a bare setFirebaseUser wouldn't
  // re-render the route gates. Driving `email_confirmed_at` off this keeps
  // verification reactive across tabs/refreshes.
  const [emailVerified, setEmailVerified] = useState(false);

  const fetchProfile = useCallback(async () => {
    // One retry, then on persistent failure keep the last known profile.
    // Nulling it here made every route gate read "not onboarded" and bounce
    // the user into /onboarding whenever a single profiles request flaked.
    let res = await db.from('profiles').select('*').limit(1);
    if (res.error) {
      await new Promise((r) => setTimeout(r, 600));
      res = await db.from('profiles').select('*').limit(1);
      if (res.error) return;
    }
    setProfile(((res.data?.[0] ?? null) as unknown) as Profile | null);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (firebaseUser?.uid) await fetchProfile();
  }, [firebaseUser?.uid, fetchProfile]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setFirebaseUser(u ?? null);
      setEmailVerified(u?.emailVerified ?? false);
      // Re-raise `loading` while we (re)fetch the profile. This callback also
      // fires on sign-in and on hourly token refresh — moments when `loading`
      // is already false. Without re-raising it there's a render where session
      // is truthy but profile is still null/stale, and the route gates read
      // that as "not onboarded" and flash /onboarding before the fetch lands.
      // Awaiting the fetch before clearing `loading` closes that window.
      if (u?.uid) {
        setLoading(true);
        try {
          await fetchProfile();
        } catch {
          // fetchProfile already swallows its own errors and keeps the last
          // known profile; this guards against anything unexpected.
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
  }, []);

  const reloadUser = useCallback(async () => {
    if (!auth.currentUser) return false;
    await auth.currentUser.reload();
    const verified = auth.currentUser.emailVerified;
    setEmailVerified(verified);
    return verified;
  }, []);

  // `email_confirmed_at` is derived from the reactive `emailVerified` state
  // (not the possibly-stale firebaseUser object) so route gates re-render the
  // instant verification lands.
  const user = useMemo(
    () =>
      firebaseUser
        ? { ...compat(firebaseUser), email_confirmed_at: emailVerified ? new Date().toISOString() : null }
        : null,
    [firebaseUser, emailVerified]
  );

  const value: AuthContextValue = {
    session: user ? { user, access_token: null } : null,
    user,
    profile,
    loading,
    emailVerified,
    signOut,
    refreshProfile,
    reloadUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
