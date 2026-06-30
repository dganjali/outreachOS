// ME → Personalization. The home for reusable voices.
//
// Replaces the old "Voice" workshop that dumped every setting (substance,
// exemplars, clarify, calibrate, your-voice) onto one screen. Now it's a calm
// list of voices; creating or editing one drops into the guided PersonaWizard,
// so configuration is progressive instead of a wall.

import { useCallback, useEffect, useState } from 'react';
import { Mic2, Plus, Check, Trash2, Loader2, Pencil } from 'lucide-react';
import { listPersonas, deletePersona, updatePersona, isPersonaCalibrated } from '../../lib/personas';
import { PersonaWizard } from '../../components/persona/PersonaWizard';
import type { Persona } from '../../types';

export function PersonaStudio({ userId }: { userId: string | undefined }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // null = list view; 'new' = create wizard; string = edit that persona.
  const [active, setActive] = useState<'new' | string | null>(null);
  // Persona id awaiting delete confirmation, and the one currently deleting.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Inline rename: the card whose name is being edited, the draft, and a saving flag.
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);

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

  async function handleDelete(id: string) {
    setDeletingId(id);
    setError(null);
    try {
      await deletePersona(id);
      setConfirmId(null);
      // Drop it locally for an instant response, then reconcile with the server.
      setPersonas((prev) => prev.filter((p) => p.id !== id));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete this voice');
    } finally {
      setDeletingId(null);
    }
  }

  function startRename(p: Persona) {
    setEditingNameId(p.id);
    setNameDraft(p.name);
  }
  function cancelRename() {
    setEditingNameId(null);
    setNameDraft('');
  }
  async function commitRename(id: string) {
    const next = nameDraft.trim();
    const current = personas.find((x) => x.id === id);
    if (!current || next === current.name) {
      cancelRename();
      return;
    }
    // A voice needs a name you'll recognize later. Reject too-short names rather
    // than silently saving a stray keystroke; keep the field open to fix it.
    if (next.length < 2) {
      setError('Give this voice a name with at least 2 characters.');
      return;
    }
    setSavingName(true);
    setError(null);
    try {
      await updatePersona(id, { name: next });
      setPersonas((prev) => prev.map((x) => (x.id === id ? { ...x, name: next } : x)));
      setEditingNameId(null);
      setNameDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename this voice');
    } finally {
      setSavingName(false);
    }
  }

  if (!userId) return <p className="me-muted">Sign in to manage your voices.</p>;

  if (active) {
    return (
      <PersonaWizard
        userId={userId}
        personaId={active === 'new' ? undefined : active}
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
            A voice is a reusable way of writing the agent uses to draft. Build one per use case - sponsorship, recruiting, sales.
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
          <span className="me-voice-empty-sub">A short guided setup - name it, drop a few facts, paste an email, tune the tone.</span>
        </button>
      ) : (
        <div className="me-voice-grid">
          {personas.map((p) => (
            <div key={p.id} className="me-voice-card-wrap">
              {editingNameId === p.id ? (
                <div className="me-voice-card me-voice-card-editing">
                  <input
                    className="me-voice-name-input"
                    value={nameDraft}
                    autoFocus
                    maxLength={80}
                    minLength={2}
                    disabled={savingName}
                    aria-label="Voice name"
                    placeholder="Give this voice a descriptive name"
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        commitRename(p.id);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelRename();
                      }
                    }}
                    onBlur={() => commitRename(p.id)}
                  />
                  <span className="me-voice-rename-hint">
                    {savingName ? 'Saving…' : 'Enter to save · Esc to cancel'}
                  </span>
                </div>
              ) : (
                <button type="button" className="me-voice-card" onClick={() => setActive(p.id)}>
                  <div className="me-voice-card-top">
                    <span className="me-voice-name">{p.name}</span>
                  </div>
                  <p className="me-voice-summary">
                    {p.style_profile?.voice_summary?.trim() ||
                      (p.mode ? `${capitalize(p.mode)} voice` : 'No tone tuned yet')}
                  </p>
                  <div className="me-voice-status">
                    {isPersonaCalibrated(p) ? (
                      <span className="me-voice-tag is-ready">
                        <Check size={12} /> Calibrated
                      </span>
                    ) : (
                      <span className="me-voice-tag">Draft</span>
                    )}
                  </div>
                </button>
              )}

              {editingNameId !== p.id && (
                <button
                  type="button"
                  className="me-voice-rename"
                  aria-label={`Rename ${p.name}`}
                  title="Rename voice"
                  onClick={() => startRename(p)}
                >
                  <Pencil size={13} />
                </button>
              )}

              {editingNameId === p.id ? null : confirmId === p.id ? (
                <div className="me-voice-confirm" role="group" aria-label={`Delete ${p.name}?`}>
                  <span className="me-voice-confirm-label">Delete?</span>
                  <button
                    type="button"
                    className="me-voice-confirm-yes"
                    onClick={() => handleDelete(p.id)}
                    disabled={deletingId === p.id}
                  >
                    {deletingId === p.id ? <Loader2 size={13} className="pw-spin" /> : 'Delete'}
                  </button>
                  <button
                    type="button"
                    className="me-voice-confirm-no"
                    onClick={() => setConfirmId(null)}
                    disabled={deletingId === p.id}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="me-voice-del"
                  aria-label={`Delete ${p.name}`}
                  title="Delete voice"
                  onClick={() => setConfirmId(p.id)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
