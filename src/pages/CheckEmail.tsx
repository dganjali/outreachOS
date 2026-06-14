import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { AuthShell } from '../components/AuthShell';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { Button } from '@/components/ui/button';

type LocationState = { email?: string } | null;

export function CheckEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, emailVerified, reloadUser } = useAuth();
  // Prefer the address passed from sign-up; fall back to the signed-in user's
  // email when we landed here via a route gate (no navigation state).
  const email = (location.state as LocationState)?.email ?? user?.email ?? '';
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // Firebase's cached `currentUser.emailVerified` does NOT flip when the user
  // clicks the verification link in another tab — only a `reload()` refreshes
  // it. Poll reloadUser() so we advance automatically instead of forcing the
  // user to manually refresh until it "lets them in".
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const tick = async () => {
      const verified = await reloadUser();
      if (cancelled) return;
      if (verified) navigate('/onboarding', { replace: true });
    };

    tick();
    const handle = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [user, reloadUser, navigate]);

  // Already verified (e.g. landed here after the fact) — move along.
  if (user && emailVerified) {
    return <Navigate to="/onboarding" replace />;
  }

  if (!email) {
    return <Navigate to="/sign-up" replace />;
  }

  async function handleResend() {
    setResendError(null);
    setResending(true);
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    setResending(false);
    if (error) {
      setResendError(error.message);
      return;
    }
    toast.success('Verification email resent.');
  }

  return (
    <AuthShell
      title="Check your email"
      subtitle={<>We sent a verification link to <strong>{email}</strong>. Click it to finish setting up your account.</>}
      footer={
        <span>
          Wrong address? <Link to="/sign-up">Start over</Link>
        </span>
      }
    >
      <p className="rounded-md border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
        This page will continue automatically once your email is verified. Didn't get it? Check spam, or resend below.
      </p>
      <Button
        type="button"
        variant="secondary"
        className="mt-3 w-full"
        onClick={handleResend}
        disabled={resending}
      >
        {resending ? 'Resending…' : 'Resend verification email'}
      </Button>
      {resendError && (
        <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {resendError}
        </p>
      )}
    </AuthShell>
  );
}
