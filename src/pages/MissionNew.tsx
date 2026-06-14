// Mission creation — a configure-before-launch wizard.
//
// You can no longer spin up a voice and immediately fire a mission. The flow is:
//   1. Content      — what you're sending and who you want to reach
//   2. Personalization — pick an existing voice, or build one via the guided
//                        PersonaWizard (the same flow as ME → Personalization)
//   3. Review       — see everything, then launch
// A mission is only created on the final "Launch" — nothing fires half-built.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Plus, Rocket, Mic2 } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { MissionMode, Persona } from '../types';
import { listPersonas } from '../lib/personas';
import { PersonaWizard } from '../components/persona/PersonaWizard';

const MODES: Array<{ value: MissionMode; label: string; hint: string }> = [
  { value: 'sponsorship', label: 'Sponsorship', hint: 'Get companies to sponsor an event/community' },
  { value: 'bd', label: 'BD / Partnerships', hint: 'Land integration or partnership deals' },
  { value: 'internship', label: 'Internship / Job', hint: 'Land a role at a target org' },
  { value: 'recruiting', label: 'Recruiting', hint: 'Source candidates for an open role' },
  { value: 'sales', label: 'Cold Sales', hint: 'Sell a product or service' },
];

type Step = 1 | 2 | 3;
const STEP_LABELS = ['Content', 'Personalization', 'Review'];

export function MissionNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isWelcome = params.get('welcome') === '1';

  const [step, setStep] = useState<Step>(1);
  const [dir, setDir] = useState<'forward' | 'back'>('forward');

  // Step 1 — content
  const [name, setName] = useState('');
  const [mode, setMode] = useState<MissionMode>('sponsorship');
  const [whatSending, setWhatSending] = useState('');
  const [whoAndWhy, setWhoAndWhy] = useState('');
  const [geo, setGeo] = useState('');

  // Step 2 — personalization
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    listPersonas(user.id)
      .then(setPersonas)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load voices'));
  }, [user]);

  const step1Valid = name.trim() && whatSending.trim() && whoAndWhy.trim();
  const selectedPersona = personas.find((p) => p.id === personaId) ?? null;

  function goto(s: Step, direction: 'forward' | 'back') {
    setDir(direction);
    setError(null);
    setStep(s);
  }

  async function launch() {
    if (!personaId) {
      setError('Pick or build a voice first.');
      return;
    }
    setSaving(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('missions')
      .insert({
        user_id: user!.id,
        name: name.trim(),
        mode,
        goal: whatSending.trim(),
        target_description: whoAndWhy.trim(),
        geo: geo.trim() || null,
        status: 'active',
        persona_id: personaId,
      })
      .select('id')
      .single();
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    navigate(data ? `/missions/${data.id}/run` : '/missions', { replace: true });
  }

  // Building a brand-new voice replaces the mission wizard with the guided flow.
  if (creating && user) {
    return (
      <div className="mn-page animate-fade-in">
        <Link to="/missions" className="mn-back">
          <ArrowLeft size={15} /> Missions
        </Link>
        <PersonaWizard
          userId={user.id}
          embedded
          seed={{ mode, offer: whatSending, audience: whoAndWhy }}
          onCancel={() => setCreating(false)}
          onDone={(p) => {
            setPersonas((prev) => [...prev, p]);
            setPersonaId(p.id);
            setCreating(false);
            goto(3, 'forward');
          }}
        />
      </div>
    );
  }

  return (
    <div className="mn-page animate-fade-in">
      <Link to="/missions" className="mn-back">
        <ArrowLeft size={15} /> Missions
      </Link>

      <h1 className="mn-title">{isWelcome ? 'Create your first mission' : 'New mission'}</h1>

      <ol className="mn-steps">
        {STEP_LABELS.map((label, i) => {
          const n = (i + 1) as Step;
          const state = n === step ? 'active' : n < step ? 'done' : 'todo';
          return (
            <li key={label} className={`mn-step-pip mn-step-${state}`}>
              <span className="mn-step-num">{state === 'done' ? <Check size={13} /> : n}</span>
              <span className="mn-step-label">{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="pw mn-wizard">
        <div className="pw-stage" data-dir={dir}>
          <div className="pw-stage-inner" key={step}>
            {step === 1 && (
              <div className="pw-step">
                <div className="pw-q-block">
                  <h2 className="pw-q">What's this mission?</h2>
                  <p className="pw-q-hint">
                    {isWelcome
                      ? "Tell the agent what you're offering and who you want to reach — it'll find targets, contacts, and draft the emails."
                      : "Define what you're sending and who you want to reach. The agent does the rest."}
                  </p>
                </div>

                <label className="pw-field">
                  <span className="pw-field-label">Mission name</span>
                  <input
                    className="pw-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Q1 sponsorship outreach"
                    autoFocus
                  />
                </label>

                <div className="pw-field-label">Mode</div>
                <div className="pw-cards">
                  {MODES.map((m) => {
                    const on = mode === m.value;
                    return (
                      <button
                        key={m.value}
                        type="button"
                        className={`pw-card ${on ? 'is-on' : ''}`}
                        onClick={() => setMode(m.value)}
                        aria-pressed={on}
                      >
                        {on && (
                          <span className="pw-card-check">
                            <Check size={12} />
                          </span>
                        )}
                        <span className="pw-card-title">{m.label}</span>
                        <span className="pw-card-hint">{m.hint}</span>
                      </button>
                    );
                  })}
                </div>

                <label className="pw-field">
                  <span className="pw-field-label">What you're sending / your offer</span>
                  <textarea
                    className="pw-input pw-textarea"
                    rows={3}
                    value={whatSending}
                    onChange={(e) => setWhatSending(e.target.value)}
                    placeholder="Be specific. e.g. 'Sponsorship tiers $5k–25k for a 1,400-person developer conference (60% senior engineers).'"
                  />
                </label>
                <label className="pw-field">
                  <span className="pw-field-label">Who you want to reach</span>
                  <textarea
                    className="pw-input pw-textarea"
                    rows={3}
                    value={whoAndWhy}
                    onChange={(e) => setWhoAndWhy(e.target.value)}
                    placeholder="e.g. 'Dev-tools companies with active student programs and recent hackathon sponsorships in 2025.'"
                  />
                </label>
                <label className="pw-field">
                  <span className="pw-field-label">
                    Location focus <span className="pw-field-optional">· optional</span>
                  </span>
                  <input
                    className="pw-input"
                    value={geo}
                    onChange={(e) => setGeo(e.target.value)}
                    placeholder="e.g. 'Toronto, Canada' — scopes contacts to a region"
                  />
                </label>
              </div>
            )}

            {step === 2 && (
              <div className="pw-step">
                <div className="pw-q-block">
                  <h2 className="pw-q">Which voice should it write in?</h2>
                  <p className="pw-q-hint">
                    Every mission drafts as a reusable voice. Pick one, or build a new one in a short guided setup.
                  </p>
                </div>

                <div className="mn-voice-grid">
                  {personas.map((p) => {
                    const on = personaId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`pw-card mn-voice ${on ? 'is-on' : ''}`}
                        onClick={() => setPersonaId(p.id)}
                        aria-pressed={on}
                      >
                        {on && (
                          <span className="pw-card-check">
                            <Check size={12} />
                          </span>
                        )}
                        <span className="pw-card-title">
                          <Mic2 size={13} /> {p.name}
                        </span>
                        <span className="pw-card-hint">
                          {p.onboarding_completed_at ? 'Calibrated' : 'Not calibrated yet'}
                          {p.mode ? ` · ${p.mode}` : ''}
                        </span>
                      </button>
                    );
                  })}

                  <button type="button" className="mn-voice-new" onClick={() => setCreating(true)}>
                    <Plus size={16} />
                    <span>Build a new voice</span>
                    <span className="mn-voice-new-hint">Guided setup · ~1 min</span>
                  </button>
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="pw-step pw-overview">
                <div className="pw-q-block">
                  <h2 className="pw-q">Ready to launch.</h2>
                  <p className="pw-q-hint">Quick check — edit anything before the agent starts.</p>
                </div>

                <section className="pw-ov-row">
                  <div className="pw-ov-row-head">
                    <div className="pw-ov-row-titles">
                      <h3 className="pw-ov-title">{name || 'Untitled mission'}</h3>
                      <span className="pw-ov-sub">{MODES.find((m) => m.value === mode)?.label}</span>
                    </div>
                    <button type="button" className="pw-ov-edit" onClick={() => goto(1, 'back')}>
                      Edit
                    </button>
                  </div>
                  <div className="pw-ov-body">
                    <p className="pw-ov-snippet"><strong>Offer:</strong> {whatSending}</p>
                    <p className="pw-ov-snippet"><strong>Audience:</strong> {whoAndWhy}</p>
                    {geo.trim() && (
                      <p className="pw-ov-snippet"><strong>Location:</strong> {geo.trim()}</p>
                    )}
                  </div>
                </section>

                <section className="pw-ov-row">
                  <div className="pw-ov-row-head">
                    <div className="pw-ov-row-titles">
                      <h3 className="pw-ov-title">
                        <Mic2 size={14} /> {selectedPersona?.name ?? 'No voice selected'}
                      </h3>
                      {selectedPersona && (
                        <span className="pw-ov-sub">
                          {selectedPersona.onboarding_completed_at ? 'Calibrated' : 'Not calibrated'}
                        </span>
                      )}
                    </div>
                    <button type="button" className="pw-ov-edit" onClick={() => goto(2, 'back')}>
                      Change
                    </button>
                  </div>
                  {selectedPersona?.style_profile?.voice_summary && (
                    <div className="pw-ov-body">
                      <p className="pw-ov-snippet">“{selectedPersona.style_profile.voice_summary}”</p>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p role="alert" className="pw-error">
            {error}
          </p>
        )}

        <footer className="pw-actions">
          <div>
            {step > 1 && (
              <button type="button" className="pw-btn-ghost" onClick={() => goto((step - 1) as Step, 'back')} disabled={saving}>
                <ArrowLeft size={15} /> Back
              </button>
            )}
          </div>
          <div className="pw-actions-right">
            {step === 1 && (
              <button type="button" className="pw-btn-primary" onClick={() => goto(2, 'forward')} disabled={!step1Valid}>
                Next <ArrowRight size={15} />
              </button>
            )}
            {step === 2 && (
              <button type="button" className="pw-btn-primary" onClick={() => goto(3, 'forward')} disabled={!personaId}>
                Review <ArrowRight size={15} />
              </button>
            )}
            {step === 3 && (
              <button type="button" className="pw-btn-primary" onClick={launch} disabled={saving || !personaId || !step1Valid}>
                <Rocket size={15} /> {saving ? 'Launching…' : 'Launch mission'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
