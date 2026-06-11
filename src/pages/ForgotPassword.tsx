import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { AuthShell } from '../components/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/sign-in`,
    });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle={<>We sent a password reset link to <strong>{email}</strong>.</>}
        footer={<Link to="/sign-in">Back to sign in</Link>}
      >
        <p className="rounded-md border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground">
          Didn’t arrive? Check spam, or try again in a minute.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We’ll email you a secure reset link."
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="forgot-email">Email</Label>
          <Input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </div>
        <Button type="submit" className="btn-glow mt-2 border-0 font-semibold text-primary-foreground" disabled={loading}>
          {loading ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </AuthShell>
  );
}
