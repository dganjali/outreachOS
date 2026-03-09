import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';

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
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-card-header">
            <span className="auth-card-brand">OutreachOS</span>
            <h1>Check your email</h1>
          </div>
          <div className="auth-card-body">
            <p className="auth-card-message">
              We sent a password reset link to <strong>{email}</strong>.
            </p>
          </div>
          <div className="auth-card-footer">
            <p className="links">
              <Link to="/sign-in">Back to sign in</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-card-header">
          <span className="auth-card-brand">OutreachOS</span>
          <h1>Forgot password</h1>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
        <div className="auth-card-footer">
          <p className="links">
            <Link to="/sign-in">Back to sign in</Link>
          </p>
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
