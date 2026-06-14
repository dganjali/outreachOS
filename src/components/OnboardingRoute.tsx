import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function OnboardingRoute({ children }: { children: React.ReactNode }) {
  const { session, profile, loading, emailVerified } = useAuth();

  if (loading) return null;

  if (!session) {
    return <Navigate to="/sign-in" replace />;
  }

  // Don't drop unverified users into onboarding — verify email first.
  if (!emailVerified) {
    return <Navigate to="/check-email" replace />;
  }

  const onboardingComplete =
    profile?.onboarding_completed_at != null && profile.onboarding_completed_at !== '';

  if (onboardingComplete) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
