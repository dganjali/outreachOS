import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { agents } from '../lib/api';
import type { Profile } from '../types';

const TOTAL_STEPS = 4;
const STEP_NAMES = ['name', 'email', 'occupation', 'resume'] as const;

export function Onboarding() {
  const { user, profile, refreshProfile } = useAuth();
  const [step, setStep] = useState(1);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrichmentStatus, setEnrichmentStatus] = useState<string | null>(null);

  const [name, setName] = useState(profile?.name ?? '');
  const [occupation, setOccupation] = useState(profile?.role ?? '');
  const [resumeUrl, setResumeUrl] = useState(profile?.resume_url ?? '');
  const [linkedinUrl, setLinkedinUrl] = useState(profile?.linkedin_url ?? '');

  const navigate = useNavigate();
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (!profile) return;
    setName(profile.name ?? '');
    setOccupation(profile.role ?? '');
    setResumeUrl(profile.resume_url ?? '');
    setLinkedinUrl(profile.linkedin_url ?? '');
  }, [profile?.id]);

  async function upsertProfile(updates: Partial<Profile>) {
    if (!user?.id) return;
    const { data: existing } = await supabase
      .from('profiles')
      .select('id')
      .limit(1)
      .single();

    const row = {
      updated_at: new Date().toISOString(),
      ...updates,
    };

    if (existing?.id) {
      await supabase.from('profiles').update(row).eq('id', existing.id);
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

      // If the user gave us a LinkedIn URL (or a LinkedIn link in the resume slot),
      // enrich their profile in the background so the first mission they create has
      // proof points + tone ready. Failures are non-blocking — they can also retry
      // from the Me page.
      const linkedin = (updates.linkedin_url as string | null) ?? '';
      const resume = (updates.resume_url as string | null) ?? '';
      const hasLinkedin = /linkedin\.com/i.test(linkedin) || /linkedin\.com/i.test(resume);
      if (hasLinkedin) {
        try {
          setEnrichmentStatus('Enriching your profile from LinkedIn…');
          await agents.enrichProfile();
          await refreshProfile();
          setEnrichmentStatus('Profile enriched.');
        } catch (err) {
          console.error('enrich_profile_failed', err);
          setEnrichmentStatus(null);
        }
      }

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
    4: 'Drop your LinkedIn (and résumé, if you have one) so we can personalize outreach.',
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
                    We use this to auto-fill your bio, proof points, and tone — so the first mission's emails sound like you.
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

        {error && <p role="alert">{error}</p>}
        {enrichmentStatus && (
          <p className="section-hint" style={{ marginTop: '0.75rem' }}>{enrichmentStatus}</p>
        )}
      </div>
    </div>
  );
}
