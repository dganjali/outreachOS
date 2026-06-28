import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Mail, X } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { gmail } from '../lib/api';
import { PlanBilling } from '../components/PlanBilling';
import type { Integration } from '../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

function SettingsSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="panel p-6">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {hint && <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const location = useLocation();
  const [email] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Follow-ups + suppression. Auto follow-ups are OFF by default.
  const [autoOn, setAutoOn] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [suppressions, setSuppressions] = useState<Array<{ id: string; email: string; reason: string }>>([]);
  const [newEmail, setNewEmail] = useState('');
  const [suppressError, setSuppressError] = useState<string | null>(null);

  async function loadSuppressions() {
    const { data } = await supabase.from('suppressions').select('*');
    setSuppressions((data ?? []) as Array<{ id: string; email: string; reason: string }>);
  }

  async function togglePause() {
    // Must update by profile id - the shim's update().eq() only routes ids, so
    // the old .eq('user_id', ...) form failed silently and the toggle never
    // actually persisted.
    if (!profileId) {
      toast.error('Profile still loading, try again in a second.');
      return;
    }
    const next = !autoOn;
    setAutoOn(next);
    setPauseBusy(true);
    try {
      const { error: err } = await supabase
        .from('profiles')
        .update({ auto_followups: next })
        .eq('id', profileId);
      if (err) {
        setAutoOn(!next); // revert - server state did not change
        toast.error(`Could not ${next ? 'enable' : 'disable'} follow-ups: ${err.message}`);
        return;
      }
      toast.success(next ? 'Auto follow-ups on.' : 'Auto follow-ups off.');
    } finally {
      setPauseBusy(false);
    }
  }

  async function addSuppression(e: React.FormEvent) {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    if (!email) {
      setSuppressError('Enter an email address to suppress.');
      return;
    }
    // Validate before hitting the DB - a malformed address was previously
    // inserted (or silently rejected) with no feedback at all.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setSuppressError(`"${newEmail.trim()}" isn't a valid email address.`);
      return;
    }
    if (suppressions.some((s) => s.email.toLowerCase() === email)) {
      setSuppressError(`${email} is already on the list.`);
      return;
    }
    setSuppressError(null);
    const { error: err } = await supabase.from('suppressions').insert({ email, reason: 'manual', note: null });
    if (err) {
      setSuppressError(`Could not suppress ${email}: ${err.message}`);
      toast.error(`Could not suppress ${email}: ${err.message}`);
      return;
    }
    setNewEmail('');
    toast.success(`${email} will never be emailed.`);
    await loadSuppressions();
  }

  async function removeSuppression(id: string) {
    const { error: err } = await supabase.from('suppressions').delete().eq('id', id);
    if (err) {
      toast.error(`Could not remove: ${err.message}`);
      return;
    }
    setSuppressions((s) => s.filter((x) => x.id !== id));
  }

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

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .single()
      .then(({ data }) => {
        if (data) {
          const row = data as { id?: string; auto_followups?: boolean };
          setAutoOn(!!row.auto_followups);
          setProfileId(row.id ?? null);
        }
      });
    void loadSuppressions();
  }, [user?.id]);

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
    if (
      !(await confirm({
        title: 'Disconnect Gmail?',
        description: 'Future agent sends will fail until you reconnect.',
        confirmText: 'Disconnect',
        destructive: true,
      }))
    )
      return;
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
    <div className="mx-auto flex max-w-2xl flex-col gap-6 animate-fade-in">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Account, integrations, and security.</p>
      </header>

      <SettingsSection
        title="Plan & billing"
        hint="Your plan sets how many missions you can launch each month and how many agent runs you get per day. Upgrade any time - changes take effect immediately."
      >
        <PlanBilling />
      </SettingsSection>

      <SettingsSection
        title="Integrations"
        hint="Connect Gmail to send outreach from your own address. You approve every email in OutreachOS before it sends."
      >
        {gmailLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Mail className="h-4 w-4" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <strong className="text-sm font-semibold text-foreground">Gmail</strong>
                  {integration ? (
                    <Badge variant="secondary" className="capitalize text-primary">{integration.status}</Badge>
                  ) : (
                    <Badge variant="secondary">not connected</Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {integration
                    ? integration.provider_account_email ?? '-'
                    : 'Required to send outreach from your address.'}
                </div>
                {integration?.last_error && (
                  <div className="mt-1 text-xs text-destructive">Last error: {integration.last_error}</div>
                )}
                {integration?.deliverability && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Sending health:{' '}
                    {integration.deliverability.domainAuth === 'gmail'
                      ? 'Gmail address, authenticated by Google.'
                      : integration.deliverability.domainAuth === 'ok'
                        ? 'Domain authenticated (SPF + DMARC found).'
                        : integration.deliverability.domainAuth === 'partial'
                          ? 'Partly set up. Add the missing SPF/DMARC records for best deliverability.'
                          : 'No SPF/DMARC found. Set them up so your mail is not marked spam.'}
                  </div>
                )}
              </div>
            </div>
            {integration ? (
              <Button variant="outline" size="sm" onClick={disconnectGmail} disabled={gmailBusy}>
                Disconnect
              </Button>
            ) : (
              <Button size="sm" className="btn-glow border-0 font-semibold text-primary-foreground" onClick={connectGmail} disabled={gmailBusy}>
                {gmailBusy ? 'Redirecting…' : 'Connect Gmail'}
              </Button>
            )}
          </div>
        )}

        {gmailFlash && (
          <p
            className={cn(
              'mt-3 rounded-md border px-3 py-2 text-sm',
              gmailFlash.startsWith('Gmail connected') || gmailFlash === 'Gmail disconnected.'
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            )}
          >
            {gmailFlash}
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title="Follow-ups & sending"
        hint="Auto follow-ups are off by default. OutreachOS sends with a Gmail scope that can't read your inbox, so it can't tell when someone replies. With auto follow-ups off, only the initial email goes out and you send any follow-ups yourself. Turn it on and OutreachOS schedules the follow-up cadence on every send (mark a contact replied to stop theirs). Suppressed addresses are never emailed."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant={autoOn ? 'default' : 'outline'}
            size="sm"
            onClick={togglePause}
            disabled={pauseBusy}
          >
            {autoOn ? 'Turn off auto follow-ups' : 'Turn on auto follow-ups'}
          </Button>
          <span className="text-sm text-muted-foreground">
            {autoOn
              ? 'On. Follow-ups schedule automatically when you send.'
              : 'Off. Only the initial email sends; follow-ups are manual.'}
          </span>
        </div>

        <h4 className="mt-6 text-sm font-semibold text-foreground">Suppression list</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Addresses here are never emailed. Unsubscribes are added automatically.
        </p>
        <form className="mt-3 flex flex-col gap-1.5" onSubmit={addSuppression}>
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="name@company.com"
              value={newEmail}
              onChange={(e) => {
                setNewEmail(e.target.value);
                if (suppressError) setSuppressError(null);
              }}
              aria-invalid={!!suppressError}
              aria-describedby={suppressError ? 'suppress-error' : undefined}
              className="max-w-xs"
            />
            <Button type="submit" variant="outline" size="sm" disabled={!newEmail.trim()}>
              Suppress
            </Button>
          </div>
          {suppressError && (
            <p id="suppress-error" role="alert" className="text-xs font-medium text-destructive">
              {suppressError}
            </p>
          )}
        </form>
        {suppressions.length > 0 && (
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {suppressions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-medium text-foreground">{s.email}</span>{' '}
                  <span className="text-xs text-muted-foreground">{s.reason}</span>
                </span>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                  onClick={() => removeSuppression(s.id)}
                >
                  <X className="h-3.5 w-3.5" /> Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <SettingsSection title="Account">
        <div className="flex max-w-sm flex-col gap-2">
          <Label htmlFor="account-email">Email</Label>
          <Input id="account-email" type="email" value={email} readOnly disabled />
          <p className="text-xs text-muted-foreground">Change via your auth provider.</p>
        </div>
      </SettingsSection>

      <SettingsSection title="Password">
        <form onSubmit={handlePasswordChange}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password">Confirm</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="mt-4">
            <Button type="submit" disabled={loading}>
              {loading ? 'Updating…' : 'Update password'}
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="mt-4 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-primary">
            {message}
          </p>
        )}
      </SettingsSection>
    </div>
  );
}
