// Custom Firebase email action handler.
//
// Firebase's DEFAULT verification link is a plain GET that completes
// verification server-side the instant it's fetched — so a mail provider's
// link scanner / prefetcher (Gmail, Outlook Safe Links, corporate proxies)
// silently verifies the account before the user does anything. That's what
// made signup "skip" verification.
//
// Pointing Firebase's action URL at THIS page (see the console steps in the PR
// notes) makes verification require an explicit button click: a scanner that
// only fetches the URL never clicks "Confirm my email", so the account stays
// unverified until the real person acts. `checkActionCode` /
// `verifyPasswordResetCode` here are read-only (they inspect, they don't
// consume the code), so even a JS-executing scanner can't complete the action.
//
// Customizing the action URL routes EVERY email action through this page, so it
// handles all modes — verifyEmail, resetPassword, recoverEmail, and
// verifyAndChangeEmail — not just verification.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  applyActionCode,
  checkActionCode,
  confirmPasswordReset,
  verifyPasswordResetCode,
} from 'firebase/auth';
import { auth } from '../firebaseClient';
import { useAuth } from '../context/AuthContext';
import { AuthShell } from '../components/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Mode = 'verifyEmail' | 'resetPassword' | 'recoverEmail' | 'verifyAndChangeEmail';

function friendlyError(code: string): string {
  switch (code) {
    case 'auth/expired-action-code':
      return 'This link has expired. Request a new one and try again.';
    case 'auth/invalid-action-code':
      return 'This link is invalid or has already been used. Request a new one.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact support if that’s unexpected.';
    case 'auth/user-not-found':
      return 'We couldn’t find an account for this link.';
    case 'auth/weak-password':
      return 'Choose a stronger password — at least 8 characters.';
    default:
      return 'Something went wrong with this link. Request a new one and try again.';
  }
}

const ALERT_CLASS =
  'rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive';
const INFO_CLASS =
  'rounded-md border border-border bg-secondary/40 px-3 py-2.5 text-sm text-muted-foreground';

export function AuthAction() {
  const [params] = useSearchParams();
  const mode = params.get('mode') as Mode | null;
  const oobCode = params.get('oobCode') ?? '';

  if (!mode || !oobCode) {
    return (
      <AuthShell
        title="Invalid link"
        subtitle="This link is missing some information."
        footer={<Link to="/sign-in">Back to sign in</Link>}
      >
        <p className={ALERT_CLASS} role="alert">
          Open the most recent email from us and click the button again.
        </p>
      </AuthShell>
    );
  }

  switch (mode) {
    case 'resetPassword':
      return <ResetPassword oobCode={oobCode} />;
    case 'verifyEmail':
    case 'verifyAndChangeEmail':
      return <VerifyEmail oobCode={oobCode} />;
    case 'recoverEmail':
      return <RecoverEmail oobCode={oobCode} />;
    default:
      return (
        <AuthShell
          title="Unsupported request"
          subtitle="We don’t know how to handle this link."
          footer={<Link to="/sign-in">Back to sign in</Link>}
        >
          <p className={ALERT_CLASS} role="alert">
            Try the most recent email, or start over from sign in.
          </p>
        </AuthShell>
      );
  }
}

// ---------------------------------------------------------------------------
// Email verification — the prefetch-proof path. The code is only consumed when
// the user clicks the button; the upfront checkActionCode is read-only.
// ---------------------------------------------------------------------------
function VerifyEmail({ oobCode }: { oobCode: string }) {
  const navigate = useNavigate();
  const { reloadUser } = useAuth();
  const [email, setEmail] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Inspect (does NOT consume) the code so we can name the address. If the code
  // is already bad, surface it now instead of after the click.
  useEffect(() => {
    let cancelled = false;
    checkActionCode(auth, oobCode)
      .then((info) => {
        if (!cancelled) setEmail(info.data.email ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(friendlyError((err as { code?: string })?.code ?? ''));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  async function confirm() {
    setPhase('confirming');
    setError(null);
    try {
      await applyActionCode(auth, oobCode);
      // Same browser they signed up in? Refresh the flag and drop them straight
      // into setup. Different device? Show success and point them to sign in —
      // their original tab is polling and will continue on its own.
      if (auth.currentUser) {
        await reloadUser();
        navigate('/onboarding', { replace: true });
        return;
      }
      setPhase('done');
    } catch (err: unknown) {
      setError(friendlyError((err as { code?: string })?.code ?? ''));
      setPhase('error');
    }
  }

  if (phase === 'done') {
    return (
      <AuthShell
        title="Email verified"
        subtitle={
          <>
            {email ? <strong>{email}</strong> : 'Your email'} is confirmed — you’re all set.
          </>
        }
        footer={<Link to="/sign-in">Continue to sign in</Link>}
      >
        <p className={INFO_CLASS}>
          If you started signing up in another tab, you can return to it — it’ll continue
          automatically now that you’re verified.
        </p>
      </AuthShell>
    );
  }

  if (phase === 'error') {
    return (
      <AuthShell
        title="Couldn’t verify"
        subtitle="This verification link didn’t work."
        footer={<Link to="/sign-in">Back to sign in</Link>}
      >
        <p className={ALERT_CLASS} role="alert">
          {error}
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Verify your email"
      subtitle={
        email ? (
          <>
            Confirm <strong>{email}</strong> to finish setting up your account.
          </>
        ) : (
          'Confirm your email to finish setting up your account.'
        )
      }
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
      <Button
        type="button"
        className="btn-glow w-full border-0 font-semibold text-primary-foreground"
        onClick={confirm}
        disabled={phase === 'confirming'}
      >
        {phase === 'confirming' ? 'Verifying…' : 'Confirm my email'}
      </Button>
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Password reset — verifyPasswordResetCode is read-only; the reset only happens
// on submit. Routed here because the custom action URL covers all email actions.
// ---------------------------------------------------------------------------
function ResetPassword({ oobCode }: { oobCode: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<'checking' | 'ready' | 'saving' | 'done' | 'error'>(
    'checking'
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    verifyPasswordResetCode(auth, oobCode)
      .then((mail) => {
        if (cancelled) return;
        setEmail(mail);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(friendlyError((err as { code?: string })?.code ?? ''));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPhase('saving');
    setError(null);
    try {
      await confirmPasswordReset(auth, oobCode, password);
      setPhase('done');
    } catch (err: unknown) {
      setError(friendlyError((err as { code?: string })?.code ?? ''));
      setPhase('ready');
    }
  }

  if (phase === 'checking') {
    return (
      <AuthShell title="Reset your password" subtitle="Checking your link…">
        <p className={INFO_CLASS}>One moment.</p>
      </AuthShell>
    );
  }

  if (phase === 'error') {
    return (
      <AuthShell
        title="Link expired"
        subtitle="This password reset link is no longer valid."
        footer={<Link to="/forgot-password">Request a new link</Link>}
      >
        <p className={ALERT_CLASS} role="alert">
          {error}
        </p>
      </AuthShell>
    );
  }

  if (phase === 'done') {
    return (
      <AuthShell
        title="Password updated"
        subtitle={
          <>
            Your password for {email ? <strong>{email}</strong> : 'your account'} has been changed.
          </>
        }
        footer={<Link to="/sign-in">Continue to sign in</Link>}
      >
        <p className={INFO_CLASS}>You can now sign in with your new password.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle={
        email ? (
          <>
            For <strong>{email}</strong>.
          </>
        ) : undefined
      }
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-password">New password</Label>
          <Input
            id="new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            placeholder="At least 8 characters"
            minLength={8}
            autoFocus
          />
        </div>
        <Button
          type="submit"
          className="btn-glow mt-2 border-0 font-semibold text-primary-foreground"
          disabled={phase === 'saving' || password.length < 8}
        >
          {phase === 'saving' ? 'Saving…' : 'Update password'}
        </Button>
      </form>
      {error && (
        <p className={`mt-4 ${ALERT_CLASS}`} role="alert">
          {error}
        </p>
      )}
    </AuthShell>
  );
}

// ---------------------------------------------------------------------------
// Email-change recovery — undo an email change. Button-gated for the same
// prefetch-safety reason as verification.
// ---------------------------------------------------------------------------
function RecoverEmail({ oobCode }: { oobCode: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'restoring' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkActionCode(auth, oobCode)
      .then((info) => {
        if (!cancelled) setEmail(info.data.email ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(friendlyError((err as { code?: string })?.code ?? ''));
        setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [oobCode]);

  async function restore() {
    setPhase('restoring');
    setError(null);
    try {
      await applyActionCode(auth, oobCode);
      setPhase('done');
    } catch (err: unknown) {
      setError(friendlyError((err as { code?: string })?.code ?? ''));
      setPhase('error');
    }
  }

  if (phase === 'done') {
    return (
      <AuthShell
        title="Email restored"
        subtitle={
          <>
            Your account email has been changed back{email ? <> to <strong>{email}</strong></> : ''}.
            We recommend resetting your password too.
          </>
        }
        footer={<Link to="/forgot-password">Reset password</Link>}
      >
        <p className={INFO_CLASS}>If you didn’t request the original change, reset your password now.</p>
      </AuthShell>
    );
  }

  if (phase === 'error') {
    return (
      <AuthShell
        title="Couldn’t restore email"
        subtitle="This recovery link didn’t work."
        footer={<Link to="/sign-in">Back to sign in</Link>}
      >
        <p className={ALERT_CLASS} role="alert">
          {error}
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Restore your email"
      subtitle={
        email ? (
          <>
            Change your account email back to <strong>{email}</strong>?
          </>
        ) : (
          'Undo the recent change to your account email?'
        )
      }
      footer={<Link to="/sign-in">Back to sign in</Link>}
    >
      <Button
        type="button"
        className="btn-glow w-full border-0 font-semibold text-primary-foreground"
        onClick={restore}
        disabled={phase === 'restoring'}
      >
        {phase === 'restoring' ? 'Restoring…' : 'Restore my email'}
      </Button>
    </AuthShell>
  );
}
