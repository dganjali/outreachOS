import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { AuthShell } from '../components/AuthShell';
import { useToast } from '../context/ToastContext';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/dashboard';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedsConfirm(false);
    setLoading(true);
    const { error: err } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (err) {
      if (/email not confirmed/i.test(err.message)) {
        setNeedsConfirm(true);
      } else {
        setError(err.message);
      }
      return;
    }
    navigate(from, { replace: true });
  }

  async function handleResend() {
    setResending(true);
    const { error: err } = await supabase.auth.resend({ type: 'signup', email });
    setResending(false);
    if (err) {
      toast.error(err.message);
      return;
    }
    toast.success('Verification email resent.');
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to keep your missions moving."
      footer={
        <>
          <Link to="/forgot-password">Forgot password?</Link>
          <span>
            New here? <Link to="/sign-up">Create an account</Link>
          </span>
        </>
      }
    >
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div className="field">
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </div>
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {error && <p role="alert" className="auth-alert">{error}</p>}
      {needsConfirm && (
        <div role="alert" className="auth-alert" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <span>Your email isn't verified yet. Check your inbox for the link, or resend it below.</span>
          <button
            type="button"
            className="btn-primary"
            onClick={handleResend}
            disabled={resending || !email}
            style={{ alignSelf: 'flex-start' }}
          >
            {resending ? 'Resending…' : 'Resend verification email'}
          </button>
        </div>
      )}
    </AuthShell>
  );
}
