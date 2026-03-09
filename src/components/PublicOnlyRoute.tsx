import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { session, profile, loading } = useAuth();

  if (loading) return null;

  if (!session) return <>{children}</>;

  const onboardingComplete =
    profile?.onboarding_completed_at != null && profile.onboarding_completed_at !== '';

  if (!onboardingComplete) return <Navigate to="/onboarding" replace />;
  return <Navigate to="/dashboard" replace />;
}
