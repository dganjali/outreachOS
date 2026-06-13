// ME → Personalization. The home for reusable voices.
//
// Replaces the old "Voice" workshop that dumped every setting (substance,
// exemplars, clarify, calibrate, your-voice) onto one screen. Now it's a calm
// list of voices; creating or editing one drops into the guided PersonaWizard,
// so configuration is progressive instead of a wall.

import { useCallback, useEffect, useState } from 'react';
import { Mic2, Plus, Check, ChevronRight } from 'lucide-react';
import { listPersonas } from '../../lib/personas';
import { PersonaWizard } from '../../components/persona/PersonaWizard';
import type { Persona } from '../../types';

export function PersonaStudio({ userId, importable }: { userId: string | undefined; importable?: string[] }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // null = list view; 'new' = create wizard; string = edit that persona.
  const [active, setActive] = useState<'new' | string | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      setPersonas(await listPersonas(userId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your voices');
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!userId) return <p className="me-muted">Sign in to manage your voices.</p>;

  if (active) {
    return (
      <PersonaWizard
        userId={userId}
        personaId={active === 'new' ? undefined : active}
        importable={active === 'new' ? importable : undefined}
        onCancel={() => setActive(null)}
        onDone={() => {
          setActive(null);
          refresh();
        }}
      />
    );
  }

  return (
    <div className="me-personalization">
      <div className="me-section-head">
        <div>
          <h2 className="me-section-title">Your voices</h2>
          <p className="me-section-hint">
            A voice is a reusable way of writing the agent uses to draft. Build one per use case — sponsorship, recruiting, sales.
          </p>
        </div>
        <button type="button" className="me-newvoice" onClick={() => setActive('new')}>
          <Plus size={15} /> New voice
        </button>
      </div>

      {error && <p className="banner-error">{error}</p>}

      {loading ? (
        <div className="me-voice-grid">
          <div className="me-voice-skel" />
          <div className="me-voice-skel" />
        </div>
      ) : personas.length === 0 ? (
        <button type="button" className="me-voice-empty" onClick={() => setActive('new')}>
          <span className="me-voice-empty-icon">
            <Mic2 size={20} />
          </span>
          <span className="me-voice-empty-title">Create your first voice</span>
          <span className="me-voice-empty-sub">A short guided setup — name it, drop a few facts, paste an email, tune the tone.</span>
        </button>
      ) : (
        <div className="me-voice-grid">
          {personas.map((p) => (
            <button key={p.id} type="button" className="me-voice-card" onClick={() => setActive(p.id)}>
              <div className="me-voice-card-top">
                <span className="me-voice-name">{p.name}</span>
                <ChevronRight size={16} className="me-voice-chev" />
              </div>
              <p className="me-voice-summary">
                {p.style_profile?.voice_summary?.trim() ||
                  (p.mode ? `${capitalize(p.mode)} voice` : 'No tone tuned yet')}
              </p>
              <div className="me-voice-status">
                {p.onboarding_completed_at ? (
                  <span className="me-voice-tag is-ready">
                    <Check size={12} /> Calibrated
                  </span>
                ) : (
                  <span className="me-voice-tag">Draft</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
