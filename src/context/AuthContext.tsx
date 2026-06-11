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
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
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

  const fetchProfile = useCallback(async () => {
    const { data } = await db.from('profiles').select('*').limit(1);
    setProfile(((data?.[0] ?? null) as unknown) as Profile | null);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (firebaseUser?.uid) await fetchProfile();
  }, [firebaseUser?.uid, fetchProfile]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setFirebaseUser(u ?? null);
      // Await the profile fetch BEFORE clearing `loading`. Otherwise there's a
      // window where loading=false and profile=null, which the onboarding gates
      // read as "not onboarded" and bounce the user to /onboarding on every load.
      if (u?.uid) {
        try {
          await fetchProfile();
        } catch {
          setProfile(null);
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

  const user = useMemo(() => (firebaseUser ? compat(firebaseUser) : null), [firebaseUser]);

  const value: AuthContextValue = {
    session: user ? { user, access_token: null } : null,
    user,
    profile,
    loading,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
