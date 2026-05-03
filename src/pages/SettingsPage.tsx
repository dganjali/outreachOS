import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { gmail } from '../lib/api';
import type { Integration } from '../types';

export function SettingsPage() {
  const { user } = useAuth();
  const location = useLocation();
  const [email] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Gmail
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [gmailLoading, setGmailLoading] = useState(true);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailFlash, setGmailFlash] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const connected = params.get('connected');
    const errParam = params.get('error');
    if (connected === 'gmail') setGmailFlash('Gmail connected.');
    if (errParam) setGmailFlash(`Gmail connection failed: ${errParam}`);
  }, [location.search]);

  async function loadGmailStatus() {
    setGmailLoading(true);
    try {
      const r = await gmail.status();
      setIntegration(r.integration);
    } catch {
      setIntegration(null);
    } finally {
      setGmailLoading(false);
    }
  }

  useEffect(() => {
    loadGmailStatus();
  }, []);

  async function connectGmail() {
    setGmailBusy(true);
    setGmailFlash(null);
    try {
      const { url } = await gmail.start();
      window.location.href = url;
    } catch (err) {
      setGmailFlash(err instanceof Error ? err.message : 'Failed to start Gmail OAuth');
      setGmailBusy(false);
    }
  }

  async function disconnectGmail() {
    if (!confirm('Disconnect Gmail? Future agent sends will fail until you reconnect.')) return;
    setGmailBusy(true);
    try {
      await gmail.disconnect();
      setIntegration(null);
      setGmailFlash('Gmail disconnected.');
    } catch (err) {
      setGmailFlash(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setGmailBusy(false);
    }
  }

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
    <div className="profile-page">
      <header className="dashboard-header">
        <div>
          <h1 style={{ margin: 0 }}>Settings</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Account, integrations, and security.
          </p>
        </div>
      </header>

      <div className="profile-form">
        <section className="profile-section">
          <h2>Integrations</h2>
          <p className="section-hint">
            Connect Gmail to create drafts in your inbox or send via OutreachOS, with reply tracking.
          </p>

          {gmailLoading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
          ) : integration ? (
            <div className="integration-card connected">
              <div>
                <div className="integration-title">
                  <strong>Gmail</strong>
                  <span className={`status-pill status-${integration.status}`}>{integration.status}</span>
                </div>
                <div className="integration-email">{integration.provider_account_email ?? '—'}</div>
                {integration.last_error && (
                  <div className="integration-error">Last error: {integration.last_error}</div>
                )}
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={disconnectGmail}
                disabled={gmailBusy}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="integration-card">
              <div>
                <div className="integration-title">
                  <strong>Gmail</strong>
                  <span className="status-pill">not connected</span>
                </div>
                <div className="integration-email muted">
                  Required to send outreach and detect replies.
                </div>
              </div>
              <button
                type="button"
                className="btn-primary"
                onClick={connectGmail}
                disabled={gmailBusy}
              >
                {gmailBusy ? 'Redirecting…' : 'Connect Gmail'}
              </button>
            </div>
          )}

          {gmailFlash && (
            <p className={gmailFlash.startsWith('Gmail connected') || gmailFlash === 'Gmail disconnected.' ? 'flash success' : 'flash error'}>
              {gmailFlash}
            </p>
          )}
        </section>

        <section className="profile-section">
          <h2>Account</h2>
          <div className="field">
            <label>Email</label>
            <input type="email" value={email} readOnly disabled />
            <p className="section-hint">Change via your auth provider.</p>
          </div>
        </section>

        <section className="profile-section">
          <h2>Password</h2>
          <form onSubmit={handlePasswordChange}>
            <div className="profile-grid">
              <div className="field">
                <label>New password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="field">
                <label>Confirm</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <div className="profile-actions">
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Updating…' : 'Update password'}
              </button>
            </div>
          </form>
          {error && <p role="alert" className="banner-error">{error}</p>}
          {message && <p role="status" className="flash success">{message}</p>}
        </section>
      </div>
    </div>
  );
}
