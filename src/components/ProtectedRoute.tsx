import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, profile, loading, emailVerified } = useAuth();
  const location = useLocation();

  if (loading) return null;

  if (!session) {
    return <Navigate to="/sign-in" state={{ from: location }} replace />;
  }

  // Signed in but email not yet confirmed — hold at the verification gate
  // rather than letting them into onboarding / the app.
  if (!emailVerified) {
    return <Navigate to="/check-email" replace />;
  }

  const onboardingComplete =
    profile?.onboarding_completed_at != null && profile.onboarding_completed_at !== '';

  if (!onboardingComplete && !location.pathname.startsWith('/onboarding')) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
}
