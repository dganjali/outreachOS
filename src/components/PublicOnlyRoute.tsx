import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { session, profile, loading, emailVerified } = useAuth();

  if (loading) return null;

  if (!session) return <>{children}</>;

  // A freshly-signed-up (unverified) user is technically "signed in" via
  // Firebase. Keep them on the verification gate instead of bouncing them to
  // onboarding/dashboard.
  if (!emailVerified) return <Navigate to="/check-email" replace />;

  const onboardingComplete =
    profile?.onboarding_completed_at != null && profile.onboarding_completed_at !== '';

  if (!onboardingComplete) return <Navigate to="/onboarding" replace />;
  return <Navigate to="/dashboard" replace />;
}
