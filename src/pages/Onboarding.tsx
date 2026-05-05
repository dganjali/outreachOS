import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { Profile } from '../types';

const TOTAL_STEPS = 5;
const STEP_NAMES = ['name', 'email', 'occupation', 'resume', 'templates'] as const;

export function Onboarding() {
  const { user, profile, refreshProfile } = useAuth();
  const [step, setStep] = useState(1);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(profile?.name ?? '');
  const [occupation, setOccupation] = useState(profile?.role ?? '');
  const [resumeUrl, setResumeUrl] = useState(profile?.resume_url ?? '');
  const [emailTemplates, setEmailTemplates] = useState(profile?.example_emails ?? '');

  const navigate = useNavigate();
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (!profile) return;
    setName(profile.name ?? '');
    setOccupation(profile.role ?? '');
    setResumeUrl(profile.resume_url ?? '');
    setEmailTemplates(profile.example_emails ?? '');
  }, [profile?.id]);

  async function upsertProfile(updates: Partial<Profile>) {
    if (!user?.id) return;
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single();

    const row = {
      user_id: user.id,
      updated_at: new Date().toISOString(),
      ...updates,
    };

    if (existing) {
      await supabase.from('profiles').update(row).eq('user_id', user.id);
    } else {
      await supabase.from('profiles').insert({
        ...row,
        onboarding_step: 0,
      });
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

  async function handleFinish() {
    setError(null);
    setSaving(true);
    try {
      await upsertProfile({
        example_emails: emailTemplates.trim() || null,
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
    4: 'Add your resume (link) so we can personalize outreach.',
    5: 'Templates of successful emails you’ve drafted (if any)',
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
                  <label htmlFor="onboarding-resume">Resume or LinkedIn URL</label>
                  <input
                    id="onboarding-resume"
                    type="url"
                    value={resumeUrl}
                    onChange={(e) => setResumeUrl(e.target.value)}
                    placeholder="https://..."
                    autoFocus
                  />
                </div>
                <div className="get-to-know-you-skip">
                  <button
                    type="button"
                    onClick={() => saveAndNext({ resume_url: null }, 5)}
                    disabled={saving}
                  >
                    Skip for now
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
                  <label htmlFor="onboarding-templates">Paste examples (optional)</label>
                  <textarea
                    id="onboarding-templates"
                    value={emailTemplates}
                    onChange={(e) => setEmailTemplates(e.target.value)}
                    placeholder="Subject: ...&#10;Body: ..."
                    autoFocus
                  />
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
                onClick={() => saveAndNext({ resume_url: resumeUrl.trim() || null }, 5)}
                disabled={saving}
              >
                Next
              </button>
            )}
            {step === 5 && (
              <button
                type="button"
                className="btn-primary"
                onClick={handleFinish}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Done'}
              </button>
            )}
          </div>
        </div>

        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
