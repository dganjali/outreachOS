import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Check, Loader2 } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { gmail } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import type { Profile } from '../types';

const TOTAL_STEPS = 5;
const STEP_NAMES = ['name', 'email', 'occupation', 'gmail', 'resume'] as const;

export function Onboarding() {
  const { user, profile, refreshProfile } = useAuth();
  const [step, setStep] = useState(1);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(profile?.name ?? '');
  const [occupation, setOccupation] = useState(profile?.role ?? '');
  const [resumeUrl, setResumeUrl] = useState(profile?.resume_url ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(profile?.linkedin_url ?? '');

  // Gmail connect (optional step). Connection happens in a popup so the OAuth
  // round-trip (which lands on /settings) doesn't blow away onboarding state —
  // we just poll status and close the popup once it's connected.
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailChecking, setGmailChecking] = useState(false);
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailError, setGmailError] = useState<string | null>(null);

  const navigate = useNavigate();
  const isInitialMount = useRef(true);

  // Pull current Gmail status when the user reaches the connect step.
  useEffect(() => {
    if (step !== 4) return;
    let cancelled = false;
    setGmailChecking(true);
    gmail
      .status()
      .then((r) => {
        if (!cancelled) setGmailConnected(r.connected);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setGmailChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  async function connectGmail() {
    setGmailError(null);
    setGmailConnecting(true);
    try {
      const { url } = await gmail.start();
      const popup = window.open(url, 'gmail-oauth', 'width=520,height=680');
      if (!popup) {
        // Popup blocked — fall back to a full redirect (lands on /settings).
        window.location.href = url;
        return;
      }
      const poll = window.setInterval(async () => {
        let connected = false;
        try {
          connected = (await gmail.status()).connected;
        } catch {
          /* transient — keep polling */
        }
        if (connected) {
          window.clearInterval(poll);
          setGmailConnected(true);
          setGmailConnecting(false);
          try {
            popup.close();
          } catch {
            /* cross-origin close guard */
          }
        } else if (popup.closed) {
          window.clearInterval(poll);
          setGmailConnecting(false);
        }
      }, 1500);
    } catch (err: unknown) {
      setGmailError(err instanceof Error ? err.message : 'Could not start Gmail connection.');
      setGmailConnecting(false);
    }
  }

  useEffect(() => {
    if (!profile) return;
    setName(profile.name ?? '');
    setOccupation(profile.role ?? '');
    setResumeUrl(profile.resume_url ?? '');
    setLinkedinUrl(profile.linkedin_url ?? '');
  }, [profile?.id]);

  async function upsertProfile(updates: Partial<Profile>) {
    // The db shim reports failures via the returned `error` instead of
    // throwing. Every call here must be checked — a swallowed write error made
    // onboarding "complete" without persisting onboarding_completed_at, so the
    // route gates bounced the user straight back into onboarding.
    if (!user?.id) throw new Error('Not signed in. Please sign in again.');
    const { data: existing, error: selErr } = await supabase
      .from('profiles')
      .select('id')
      .limit(1)
      .single();
    if (selErr) throw new Error(selErr.message);

    const row = {
      updated_at: new Date().toISOString(),
      ...updates,
    };

    if (existing?.id) {
      const { error: updErr } = await supabase.from('profiles').update(row).eq('id', existing.id);
      if (updErr) throw new Error(updErr.message);
    } else {
      const { error: insErr } = await supabase.from('profiles').insert({
        ...row,
        onboarding_step: 0,
      });
      if (insErr) throw new Error(insErr.message);
    }
  }

  async function saveAndNext(updates: Partial<Profile>, nextStep: number) {
    setError(null);
    setSaving(true);
    try {
      await upsertProfile(updates);
      setDirection('forward');
      setStep(nextStep);
      await refreshProfile();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  async function goBack() {
    if (step <= 1) return;
    setDirection('back');
    setStep((s) => s - 1);
  }

  async function handleFinish(updates: Partial<Profile>) {
    setError(null);
    setSaving(true);
    try {
      await upsertProfile({
        ...updates,
        onboarding_step: TOTAL_STEPS,
        onboarding_completed_at: new Date().toISOString(),
      });
      await refreshProfile();
      navigate('/missions/new?welcome=1', { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  // Don't animate on first paint
  const animateDirection = isInitialMount.current ? undefined : direction;
  useEffect(() => {
    isInitialMount.current = false;
  }, []);

  const stepQuestions: Record<number, string> = {
    1: "What's your name?",
    2: "Here's the email we have on file.",
    3: "What's your occupation?",
    4: 'Connect Gmail to send from your own address.',
    5: 'Add your LinkedIn and résumé (optional) so they\'re on hand when you draft.',
  };

  return (
    <div className="get-to-know-you">
      <div className="get-to-know-you-card">
        <div className="get-to-know-you-header">
          <span className="get-to-know-you-brand">OutreachOS</span>
          <h1 className="get-to-know-you-title">Get to know you</h1>
        </div>

        <div className="get-to-know-you-progress" aria-hidden>
          {STEP_NAMES.map((_, i) => (
            <div
              key={i}
              className={`get-to-know-you-progress-dot ${i < step ? 'filled' : ''}`}
            />
          ))}
        </div>

        <div
          className="get-to-know-you-step"
          data-direction={animateDirection}
          role="region"
          aria-live="polite"
          aria-label={`Step ${step} of ${TOTAL_STEPS}: ${stepQuestions[step]}`}
        >
          <div className="get-to-know-you-step-inner">
            {step === 1 && (
              <>
                <p className="get-to-know-you-title" style={{ marginBottom: '1.25rem' }}>
                  {stepQuestions[1]}
                </p>
                <div className="field">
                  <label htmlFor="onboarding-name">Your name</label>
                  <input
                    id="onboarding-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Alex Chen"
                    autoFocus
                  />
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <p className="get-to-know-you-title" style={{ marginBottom: '1.25rem' }}>
                  {stepQuestions[2]}
                </p>
                <div className="field">
                  <label>Email</label>
                  <div className="get-to-know-you-email-display">
                    {user?.email ?? '—'}
                  </div>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                    We’ll use this for your account. You can change it later in Settings.
                  </p>
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <p className="get-to-know-you-title" style={{ marginBottom: '1.25rem' }}>
                  {stepQuestions[3]}
                </p>
                <div className="field">
                  <label htmlFor="onboarding-occupation">Occupation or title</label>
                  <input
                    id="onboarding-occupation"
                    type="text"
                    value={occupation}
                    onChange={(e) => setOccupation(e.target.value)}
                    placeholder="e.g. Head of Partnerships, Student"
                    autoFocus
                  />
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <p className="get-to-know-you-title" style={{ marginBottom: '1.25rem' }}>
                  {stepQuestions[4]}
                </p>
                <div className="field">
                  <div className="onboarding-gmail">
                    <div className="onboarding-gmail-row">
                      <span className="onboarding-gmail-icon" aria-hidden>
                        <Mail size={18} />
                      </span>
                      <div className="onboarding-gmail-text">
                        <strong>Gmail</strong>
                        <span>
                          {gmailChecking
                            ? 'Checking…'
                            : gmailConnected
                              ? 'Connected'
                              : 'Not connected'}
                        </span>
                      </div>
                      {gmailConnected ? (
                        <span className="onboarding-gmail-done" aria-label="Connected">
                          <Check size={16} />
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={connectGmail}
                          disabled={gmailConnecting || gmailChecking}
                        >
                          {gmailConnecting ? (
                            <>
                              <Loader2 size={14} className="pw-spin" /> Connecting…
                            </>
                          ) : (
                            'Connect Gmail'
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="section-hint">
                    Optional, and you can do it later in Settings. OutreachOS can only <strong>send</strong> — it never reads your inbox — and you approve every email before it goes out.
                  </p>
                  {gmailError && (
                    <p role="alert" className="auth-alert" style={{ marginTop: '0.5rem' }}>
                      {gmailError}
                    </p>
                  )}
                </div>
                <div className="get-to-know-you-skip">
                  <button
                    type="button"
                    onClick={() => {
                      setDirection('forward');
                      setStep(5);
                    }}
                    disabled={saving}
                  >
                    {gmailConnected ? 'Continue' : 'Skip for now'}
                  </button>
                </div>
              </>
            )}

            {step === 5 && (
              <>
                <p className="get-to-know-you-title" style={{ marginBottom: '1.25rem' }}>
                  {stepQuestions[5]}
                </p>
                <div className="field">
                  <label htmlFor="onboarding-linkedin">LinkedIn URL</label>
                  <input
                    id="onboarding-linkedin"
                    type="url"
                    value={linkedinUrl}
                    onChange={(e) => setLinkedinUrl(e.target.value)}
                    placeholder="https://www.linkedin.com/in/..."
                    autoFocus
                  />
                  <p className="section-hint">
                    Stored on your profile for reference. You'll add your own facts and tone when you set up a voice — nothing is auto-generated about you.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="onboarding-resume">Résumé URL (optional)</label>
                  <input
                    id="onboarding-resume"
                    type="url"
                    value={resumeUrl}
                    onChange={(e) => setResumeUrl(e.target.value)}
                    placeholder="https://..."
                  />
                </div>
                <div className="get-to-know-you-skip">
                  <button
                    type="button"
                    onClick={() => handleFinish({ linkedin_url: null, resume_url: null })}
                    disabled={saving}
                  >
                    Skip for now
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="get-to-know-you-actions">
          <div>
            {step > 1 ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={goBack}
                disabled={saving}
              >
                Back
              </button>
            ) : (
              <span />
            )}
          </div>
          <div>
            {step === 1 && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => saveAndNext({ name: name.trim() || null }, 2)}
                disabled={saving || !name.trim()}
              >
                {saving ? '…' : 'Next'}
              </button>
            )}
            {step === 2 && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => saveAndNext({}, 3)}
                disabled={saving}
              >
                Next
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => saveAndNext({ role: occupation.trim() || null }, 4)}
                disabled={saving}
              >
                Next
              </button>
            )}
            {step === 4 && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setDirection('forward');
                  setStep(5);
                }}
                disabled={saving}
              >
                Next
              </button>
            )}
            {step === 5 && (
              <button
                type="button"
                className="btn-primary"
                onClick={() =>
                  handleFinish({
                    linkedin_url: linkedinUrl.trim() || null,
                    resume_url: resumeUrl.trim() || null,
                  })
                }
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            )}
          </div>
        </div>

        {error && <p role="alert" className="auth-alert">{error}</p>}
      </div>
    </div>
  );
}
