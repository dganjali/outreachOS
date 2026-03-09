import { useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

export function SettingsPage() {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) setError(err.message);
    else {
      setMessage('Password updated.');
      setPassword('');
      setConfirmPassword('');
    }
  }

  return (
    <div>
      <h1>Settings</h1>

      <section>
        <h2>Account</h2>
        <div>
          <label>Email</label>
          <input type="email" value={email} readOnly disabled />
          <p>Change email via your auth provider (Supabase).</p>
        </div>
      </section>

      <section>
        <h2>Password</h2>
        <form onSubmit={handlePasswordChange}>
          <div>
            <label>New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div>
            <label>Confirm password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button type="submit" disabled={loading}>
            Update password
          </button>
        </form>
      </section>

      <section>
        <h2>Delete account</h2>
        <p>Permanently delete your account and data. (Not implemented in V1.)</p>
      </section>

      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
