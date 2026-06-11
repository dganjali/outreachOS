import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { AuthShell } from '../components/AuthShell';
import { useToast } from '../context/ToastContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="signin-email">Email</Label>
          <Input
            id="signin-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="signin-password">Password</Label>
          <Input
            id="signin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </div>
        <Button type="submit" className="btn-glow mt-2 border-0 font-semibold text-primary-foreground" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {needsConfirm && (
        <div role="alert" className="mt-4 flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-sm text-foreground">
          <span>Your email isn't verified yet. Check your inbox for the link, or resend it below.</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={handleResend}
            disabled={resending || !email}
          >
            {resending ? 'Resending…' : 'Resend verification email'}
          </Button>
        </div>
      )}
    </AuthShell>
  );
}
