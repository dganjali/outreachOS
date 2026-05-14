import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { AuthShell } from '../components/AuthShell';
import { useToast } from '../context/ToastContext';

type LocationState = { email?: string } | null;

export function CheckEmail() {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const email = (location.state as LocationState)?.email ?? '';
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // Some email providers prefetch confirm links — poll auth state so we can
  // forward to onboarding the moment Supabase says the email is verified.
  useEffect(() => {
    if (!email) return;
    let cancelled = false;

    const tick = async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      if (data.user?.email_confirmed_at) {
        navigate('/onboarding', { replace: true });
      }
    };

    tick();
    const handle = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [email, navigate]);

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
      <p className="auth-info">
        This page will continue automatically once your email is verified. Didn't get it? Check spam, or resend below.
      </p>
      <button
        type="button"
        className="btn-primary"
        onClick={handleResend}
        disabled={resending}
        style={{ marginTop: '0.75rem' }}
      >
        {resending ? 'Resending…' : 'Resend verification email'}
      </button>
      {resendError && <p role="alert" className="auth-alert">{resendError}</p>}
    </AuthShell>
  );
}
