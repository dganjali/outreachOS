// PersonaWizard — the guided, conversational way to build a reusable voice.
//
// One screen per question: Frame → Substance → Clarify → Style → Calibrate,
// then a single Overview that reveals the learned voice and lets you jump back
// to edit any section. Progressive disclosure does the work — no wall of fields.
// Used standalone in ME → Personalization and embedded inside mission creation.
//
// LLM flow (Gemini agents, server-side):
//   • Clarify   → onboard-questions: adaptive questions from gaps/contradictions
//   • Calibrate → refine: chat-edit a draft (whole or a highlighted span)
//   • Save      → extract-style: commits a confidence-weighted StyleProfile +
//                 the confirmed draft as a gold exemplar (+ version snapshot)
//
// Persistence is LAZY: the persona row is created the first time an agent needs
// it (Clarify/Calibrate), so Frame/Substance/Style stay fully navigable and a
// user who bails early leaves at most an un-calibrated "Draft" (resumable).
// Every agent call degrades gracefully — failures show inline and never trap.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import type { MissionMode, Persona } from '../../types';
import { useConfirm } from '../../context/ConfirmContext';
import { useToast } from '../../context/ToastContext';
import { agents } from '../../lib/api';
import { uploadAsset, MAX_ASSET_BYTES } from '../../lib/profileAssets';
import {
  addContextFact,
  addExemplar,
  createPersona,
  DEFAULT_TEMPLATE_STRICTNESS,
  deleteContextFact,
  deleteExemplar,
  emptyStyleProfile,
  getPersonaBundle,
  listContextFacts,
  updatePersona,
  type PersonaBundle,
} from '../../lib/personas';

// ---------------------------------------------------------------------------
// Local draft model
// ---------------------------------------------------------------------------
interface FactItem {
  id?: string; // present once persisted
  claim: string;
  /** 'person' = already persisted person-level by the extract-context agent;
   *  'persona' = local / persona-scoped (default for manual entries). */
  scope?: 'person' | 'persona';
}
interface ExItem {
  id?: string;
  body: string;
}
interface Question {
  id: string;
  question: string;
  why: string;
}

type Step = 'frame' | 'substance' | 'clarify' | 'style' | 'calibrate' | 'overview';
const INPUT_STEPS: Step[] = ['frame', 'substance', 'clarify', 'style', 'calibrate'];

const PURPOSES: Array<{ value: MissionMode; label: string; hint: string }> = [
  { value: 'sponsorship', label: 'Sponsorship', hint: 'Win sponsors for an event or community' },
  { value: 'bd', label: 'Partnerships', hint: 'Land integrations or BD deals' },
  { value: 'internship', label: 'Job / Internship', hint: 'Get a role at a target org' },
  { value: 'recruiting', label: 'Recruiting', hint: 'Source candidates for a role' },
  { value: 'sales', label: 'Cold sales', hint: 'Sell a product or service' },
];

interface PersonaWizardProps {
  userId: string;
  /** Present = edit an existing persona (opens straight on the overview). */
  personaId?: string;
  /** Seeds copied from the mission so a brand-new voice starts in context. */
  seed?: { mode?: MissionMode | null; offer?: string | null; audience?: string | null };
  onDone: (persona: Persona) => void;
  onCancel?: () => void;
  /** Tweaks chrome when rendered inside the mission flow. */
  embedded?: boolean;
}

export function PersonaWizard({
  userId,
  personaId: initialPersonaId,
  seed,
  onDone,
  onCancel,
  embedded,
}: PersonaWizardProps) {
  const editing = Boolean(initialPersonaId);
  const confirm = useConfirm();
  const toast = useToast();

  // frame
  const [name, setName] = useState('');
  const [mode, setMode] = useState<MissionMode | null>(seed?.mode ?? null);
  // substance / clarify
  const [facts, setFacts] = useState<FactItem[]>([]);
  // style
  const [exemplars, setExemplars] = useState<ExItem[]>([]);
  // how strictly the engine should follow the exemplars as a template (0–100)
  const [strictness, setStrictness] = useState<number>(DEFAULT_TEMPLATE_STRICTNESS);
  // calibrate
  const [calSubject, setCalSubject] = useState('');
  const [calBody, setCalBody] = useState('');
  const [calInstructions, setCalInstructions] = useState<string[]>([]);
  // persona (created lazily; the StyleProfile shown on the overview)
  const [persona, setPersona] = useState<Persona | null>(null);
  const personaIdRef = useRef<string | null>(initialPersonaId ?? null);

  const [step, setStep] = useState<Step>(editing ? 'overview' : 'frame');
  const [dir, setDir] = useState<'forward' | 'back'>('forward');
  const [loading, setLoading] = useState(editing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- edit mode: hydrate from the existing persona ----
  useEffect(() => {
    if (!initialPersonaId) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      getPersonaBundle(userId, initialPersonaId),
      listContextFacts(userId, null),
    ])
      .then(([b, allFacts]) => {
        if (!alive || !b) return;
        // Separate person-scoped facts from the full list.
        const personFacts = allFacts
          .filter((f) => f.scope === 'person')
          .map((f) => ({ id: f.id, claim: f.claim }));
        applyBundle(b, personFacts);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load this voice'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPersonaId, userId]);

  // ---- new voice: autofill the shared, person-level facts (managed in the
  // Context tab) so a brand-new voice starts from what the agent already knows
  // about you. Persona-specific facts are added on top. ----
  useEffect(() => {
    if (initialPersonaId) return; // edit mode hydrates its own facts
    let alive = true;
    listContextFacts(userId, null)
      .then((all) => {
        if (!alive) return;
        const personItems: FactItem[] = all
          .filter((f) => f.scope === 'person')
          .map((f) => ({ id: f.id, claim: f.claim, scope: 'person' as const }));
        if (personItems.length) setFacts((prev) => (prev.length ? prev : personItems));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPersonaId, userId]);

  function applyBundle(b: PersonaBundle, personFacts?: Array<{ id: string; claim: string }>) {
    personaIdRef.current = b.persona.id;
    setPersona(b.persona);
    setName(b.persona.name);
    setMode(b.persona.mode);
    const personaItems: FactItem[] = b.facts.map((f) => ({ id: f.id, claim: f.claim, scope: 'persona' as const }));
    // Person-level facts this voice has opted out of are hidden from the list.
    const excluded = new Set(b.persona.excluded_fact_ids ?? []);
    const personItems: FactItem[] = (personFacts ?? [])
      .filter((f) => !excluded.has(f.id))
      .map((f) => ({ id: f.id, claim: f.claim, scope: 'person' as const }));
    // Merge: person-level first (identity facts), then persona-scoped.
    setFacts([...personItems, ...personaItems]);
    setExemplars(b.exemplars.map((e) => ({ id: e.id, body: e.body })));
    setStrictness(b.persona.style_profile?.template_strictness ?? DEFAULT_TEMPLATE_STRICTNESS);
  }

  const go = useCallback((to: Step, direction: 'forward' | 'back') => {
    setDir(direction);
    setError(null);
    setStep(to);
  }, []);

  // ---- lazy persona create + persist pending facts/exemplars (idempotent) ----
  const ensurePersona = useCallback(async (): Promise<string> => {
    let pid = personaIdRef.current;
    if (!pid) {
      const p = await createPersona(userId, {
        name: name.trim() || 'Untitled voice',
        mode,
        offer: seed?.offer ?? null,
        audience: seed?.audience ?? null,
      });
      pid = p.id;
      personaIdRef.current = pid;
      setPersona(p);
    } else if (editing) {
      await updatePersona(pid, { name: name.trim() || 'Untitled voice', mode });
    }

    // Sync facts + exemplars against DB truth. Only persona-scoped facts are
    // managed here — person-level facts (scope:'person') are already persisted
    // by the extract-context agent and must NOT be re-inserted.
    const personaFacts = facts.filter((f) => f.scope !== 'person');
    const personItemsPreserved = facts.filter((f) => f.scope === 'person');

    const before = await getPersonaBundle(userId, pid);
    if (before) {
      const keptFactIds = new Set(personaFacts.filter((f) => f.id).map((f) => f.id!));
      for (const f of before.facts) if (f.id && !keptFactIds.has(f.id)) await deleteContextFact(f.id);
      for (const f of personaFacts)
        if (!f.id && f.claim.trim() && f.scope !== 'person')
          await addContextFact(userId, {
            claim: f.claim,
            type: 'proof',
            scope: 'persona',
            personaId: pid,
            provenance: 'onboarding',
          });

      const keptExIds = new Set(exemplars.filter((e) => e.id).map((e) => e.id!));
      for (const e of before.exemplars) if (e.id && !keptExIds.has(e.id)) await deleteExemplar(e.id);
      for (const e of exemplars) if (!e.id && e.body.trim()) await addExemplar(userId, pid, { body: e.body });
    }
    const after = await getPersonaBundle(userId, pid);
    if (after) {
      // Persist the template-strictness slider into the persona's style profile
      // (merged so we never clobber a learned voice). extract-style preserves it.
      const sp = after.persona.style_profile ?? emptyStyleProfile();
      if ((sp.template_strictness ?? DEFAULT_TEMPLATE_STRICTNESS) !== strictness) {
        await updatePersona(pid, { style_profile: { ...sp, template_strictness: strictness } });
        after.persona = { ...after.persona, style_profile: { ...sp, template_strictness: strictness } };
      }
      // Re-merge: preserve person-level items, replace persona-level from DB.
      const freshPersonaFacts: FactItem[] = after.facts.map((f) => ({ id: f.id, claim: f.claim, scope: 'persona' as const }));
      setFacts([...personItemsPreserved, ...freshPersonaFacts]);
      setExemplars(after.exemplars.map((e) => ({ id: e.id, body: e.body })));
      setPersona(after.persona);
    }
    return pid;
  }, [userId, name, mode, seed, editing, facts, exemplars, strictness]);

  // Opt this voice out of the shared person-level ("default") facts. They stay
  // in the Context bank and other voices — we just record their ids on the
  // persona so they're hidden here and dropped from this voice's grounding.
  const clearDefaultFacts = useCallback(async () => {
    const defaultIds = facts.filter((f) => f.scope === 'person' && f.id).map((f) => f.id!);
    if (defaultIds.length === 0) return;
    const ok = await confirm({
      title: 'Clear default facts for this voice?',
      description: `These ${defaultIds.length} shared fact${defaultIds.length === 1 ? '' : 's'} won't be used by this voice. They stay available in your Context bank and other voices.`,
      confirmText: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const pid = await ensurePersona();
      const existing = persona?.excluded_fact_ids ?? [];
      const next = Array.from(new Set([...existing, ...defaultIds]));
      await updatePersona(pid, { excluded_fact_ids: next });
      setPersona((p) => (p ? { ...p, excluded_fact_ids: next } : p));
      setFacts((f) => f.filter((x) => x.scope !== 'person'));
      toast.success('Default facts cleared for this voice.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not clear default facts.');
    } finally {
      setBusy(false);
    }
  }, [facts, persona, ensurePersona, confirm, toast]);

  // ---- step transitions (some run side effects) ----
  async function next() {
    const i = INPUT_STEPS.indexOf(step);
    setError(null);
    try {
      if (step === 'calibrate') {
        setBusy(true);
        await commitCalibration();
        go('overview', 'forward');
      } else if (step === 'style') {
        // Persist facts + exemplars before the calibrate step needs them.
        setBusy(true);
        await ensurePersona();
        go('calibrate', 'forward');
      } else if (i >= 0 && i < INPUT_STEPS.length - 1) {
        go(INPUT_STEPS[i + 1], 'forward');
      } else {
        go('overview', 'forward');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  }

  function back() {
    const i = INPUT_STEPS.indexOf(step);
    if (step === 'overview') go('calibrate', 'back');
    else if (i > 0) go(INPUT_STEPS[i - 1], 'back');
  }

  // Confirm the calibrated draft → gold exemplar + conservative rules.
  async function commitCalibration() {
    const pid = await ensurePersona();
    if (calBody.trim()) {
      await agents.extractStyle({
        persona_id: pid,
        chat_instructions: calInstructions,
        confirmed_exemplar: { subject: calSubject || null, body: calBody },
        source: 'onboarding',
      });
      const fresh = await getPersonaBundle(userId, pid);
      if (fresh) applyBundleProfile(fresh);
    }
  }

  // Reload only the persona + exemplars (facts unchanged by extract-style).
  function applyBundleProfile(b: PersonaBundle) {
    setPersona(b.persona);
    setExemplars(b.exemplars.map((e) => ({ id: e.id, body: e.body })));
    setStrictness(b.persona.style_profile?.template_strictness ?? DEFAULT_TEMPLATE_STRICTNESS);
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const pid = await ensurePersona();
      const completedAt = new Date().toISOString();
      await updatePersona(pid, { onboarding_completed_at: completedAt });
      const fresh = await getPersonaBundle(userId, pid);
      onDone(fresh?.persona ?? { ...(persona as Persona), id: pid, onboarding_completed_at: completedAt });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed — try again.');
      setBusy(false);
    }
  }

  const stepIndex = step === 'overview' ? INPUT_STEPS.length : INPUT_STEPS.indexOf(step);
  const canNextFrame = name.trim().length > 0 && mode != null;

  if (loading) {
    return (
      <div className={`pw ${embedded ? 'pw-embedded' : ''}`}>
        <div className="pw-loading">
          <Loader2 className="pw-spin" size={18} /> Loading this voice…
        </div>
      </div>
    );
  }

  return (
    <div className={`pw ${embedded ? 'pw-embedded' : ''}`}>
      <header className="pw-head">
        <div className="pw-head-meta">
          <span className="pw-kicker">
            <Sparkles size={13} /> {editing ? 'Edit voice' : 'New voice'}
          </span>
          {step !== 'overview' && (
            <span className="pw-stepcount">
              Step {stepIndex + 1} of {INPUT_STEPS.length}
            </span>
          )}
        </div>
        {onCancel && (
          <button type="button" className="pw-cancel" onClick={onCancel}>
            <X size={15} /> Cancel
          </button>
        )}
      </header>

      <div className="pw-progress" aria-hidden>
        {INPUT_STEPS.map((s, i) => (
          <span key={s} className={`pw-dot ${i < stepIndex ? 'is-done' : ''} ${i === stepIndex ? 'is-active' : ''}`} />
        ))}
        <span className={`pw-dot ${step === 'overview' ? 'is-active' : ''}`} />
      </div>

      <div className="pw-stage" data-dir={dir}>
        <div className="pw-stage-inner" key={step}>
          {step === 'frame' && <FrameStep name={name} setName={setName} mode={mode} setMode={setMode} />}
          {step === 'substance' && (
            <SubstanceStep
              facts={facts}
              setFacts={setFacts}
              userId={userId}
              personaId={personaIdRef.current ?? undefined}
              onClearDefaults={clearDefaultFacts}
              clearing={busy}
            />
          )}
          {step === 'clarify' && (
            <ClarifyStep
              facts={facts}
              addFact={(claim) => setFacts((f) => [...f, { claim }])}
              ensurePersona={ensurePersona}
            />
          )}
          {step === 'style' && (
            <StyleStep
              exemplars={exemplars}
              setExemplars={setExemplars}
              strictness={strictness}
              setStrictness={setStrictness}
            />
          )}
          {step === 'calibrate' && (
            <CalibrateStep
              subject={calSubject}
              setSubject={setCalSubject}
              body={calBody}
              setBody={setCalBody}
              instructions={calInstructions}
              setInstructions={setCalInstructions}
              ensurePersona={ensurePersona}
            />
          )}
          {step === 'overview' && (
            <OverviewStep
              name={name}
              mode={mode}
              facts={facts}
              exemplars={exemplars}
              persona={persona}
              editing={editing}
              onEdit={(s) => go(s, 'back')}
            />
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
          {step !== 'frame' && (
            <button type="button" className="pw-btn-ghost" onClick={back} disabled={busy}>
              <ArrowLeft size={15} /> Back
            </button>
          )}
        </div>
        <div className="pw-actions-right">
          {step === 'overview' ? (
            <button type="button" className="pw-btn-primary" onClick={finish} disabled={busy || !name.trim()}>
              {busy ? <Loader2 className="pw-spin" size={15} /> : <Check size={15} />}
              {editing ? 'Save changes' : 'Save voice'}
            </button>
          ) : (
            <button
              type="button"
              className="pw-btn-primary"
              onClick={next}
              disabled={busy || (step === 'frame' && !canNextFrame)}
            >
              {busy ? <Loader2 className="pw-spin" size={15} /> : null}
              {step === 'calibrate' ? 'Review' : 'Next'} <ArrowRight size={15} />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepHead({ q, hint }: { q: string; hint: string }) {
  return (
    <div className="pw-q-block">
      <h2 className="pw-q">{q}</h2>
      <p className="pw-q-hint">{hint}</p>
    </div>
  );
}

function FrameStep({
  name,
  setName,
  mode,
  setMode,
}: {
  name: string;
  setName: (v: string) => void;
  mode: MissionMode | null;
  setMode: (m: MissionMode) => void;
}) {
  return (
    <div className="pw-step">
      <StepHead q="Let's name this voice." hint="A voice is a reusable way of writing — give it a name and tell us what it's for." />
      <input
        className="pw-input pw-input-lg"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Sponsorship outreach"
        autoFocus
      />
      <div className="pw-field-label">What's it for?</div>
      <div className="pw-cards">
        {PURPOSES.map((p) => {
          const on = mode === p.value;
          return (
            <button
              key={p.value}
              type="button"
              className={`pw-card ${on ? 'is-on' : ''}`}
              onClick={() => setMode(p.value)}
              aria-pressed={on}
            >
              {on && (
                <span className="pw-card-check">
                  <Check size={12} />
                </span>
              )}
              <span className="pw-card-title">{p.label}</span>
              <span className="pw-card-hint">{p.hint}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SubstanceStep({
  facts,
  setFacts,
  userId,
  personaId,
  onClearDefaults,
  clearing,
}: {
  facts: FactItem[];
  setFacts: React.Dispatch<React.SetStateAction<FactItem[]>>;
  userId: string;
  personaId?: string;
  onClearDefaults: () => void;
  clearing: boolean;
}) {
  const defaultCount = facts.filter((f) => f.scope === 'person').length;
  const [text, setText] = useState('');
  // Smart-fill state
  const [dumpText, setDumpText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function add() {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setFacts((f) => [...f, ...lines.map((claim) => ({ claim, scope: 'persona' as const }))]);
    setText('');
  }

  async function runExtract(opts: { text?: string; assetId?: string }) {
    setExtracting(true);
    setExtractError(null);
    try {
      const r = await agents.extractContext({
        text: opts.text,
        asset_id: opts.assetId,
        persona_id: personaId,
      });
      // Extracted facts are person-level (already persisted by the agent).
      const existing = new Set(facts.map((f) => f.claim.toLowerCase()));
      const newFacts: FactItem[] = r.facts
        .filter((f) => !existing.has(f.claim.toLowerCase()))
        .map((f) => ({ id: f.id, claim: f.claim, scope: 'person' as const }));
      if (newFacts.length > 0) {
        setFacts((prev) => [...prev, ...newFacts]);
      }
      setDumpText('');
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed — try again.');
    } finally {
      setExtracting(false);
    }
  }

  async function handleFile(file: File) {
    if (file.size > MAX_ASSET_BYTES) {
      setExtractError(`File too large. Max 20MB; this file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }
    setExtracting(true);
    setExtractError(null);
    try {
      const asset = await uploadAsset({ userId, kind: 'context_dump', file });
      await runExtract({ assetId: asset.id });
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Upload failed — try again.');
      setExtracting(false);
    }
  }

  function pickFile(f: File | null | undefined) {
    if (f) handleFile(f);
  }

  async function handleRemove(i: number) {
    const fact = facts[i];
    if (fact?.scope === 'person' && fact.id) {
      try {
        await deleteContextFact(fact.id);
      } catch {
        // Best-effort — drop locally regardless.
      }
    }
    setFacts((f) => f.filter((_, idx) => idx !== i));
  }

  return (
    <div className="pw-step">
      <StepHead
        q="What makes you worth a reply?"
        hint="Drop the concrete facts a great email could cite — what you've built, real numbers, credentials. One per line. Skip the fluff."
      />

      {/* Smart-fill card */}
      <div className="pw-smartfill">
        <div className="pw-smartfill-head">
          <span className="pw-smartfill-title">
            <Sparkles size={13} /> Smart fill
          </span>
          <span className="pw-smartfill-badge">Recommended</span>
        </div>
        <p className="pw-smartfill-hint">Paste your resume, bio, or any context — or upload a file — and we'll extract the facts for you.</p>

        {/* Paste box */}
        <textarea
          className="pw-input pw-textarea"
          rows={3}
          value={dumpText}
          onChange={(e) => setDumpText(e.target.value)}
          placeholder="Paste your resume, LinkedIn bio, or any background text…"
          disabled={extracting}
        />

        {/* File dropzone */}
        <div
          className={`pw-smartfill-dropzone ${dragOver ? 'asset-dropzone-over' : ''} ${extracting ? 'asset-dropzone-busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!extracting) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (extracting) return;
            pickFile(e.dataTransfer.files?.[0]);
          }}
          onClick={() => !extracting && fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (!extracting && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              fileRef.current?.click();
            }
          }}
          aria-label="Upload a file to extract facts"
          aria-busy={extracting}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.doc,.txt,.md,.rtf,.png,.jpg,.jpeg,.webp,.heic"
            hidden
            onChange={(e) => {
              pickFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <FileText size={14} className="pw-smartfill-dropzone-icon" />
          <span className="pw-smartfill-dropzone-label">
            {extracting ? 'Reading…' : 'Drop a PDF, DOCX, image or screenshot — scanned files are OCR’d'}
          </span>
        </div>

        <button
          type="button"
          className="pw-btn-add pw-smartfill-btn"
          onClick={() => runExtract({ text: dumpText })}
          disabled={extracting || !dumpText.trim()}
        >
          {extracting ? <Loader2 className="pw-spin" size={14} /> : <Sparkles size={14} />}
          {extracting ? 'Extracting…' : 'Extract facts'}
        </button>

        {extractError && <p className="pw-error pw-smartfill-error">{extractError}</p>}
      </div>

      {/* OR divider */}
      <div className="pw-or-divider">
        <span>— or add manually —</span>
      </div>

      {/* Manual path */}
      <textarea
        className="pw-input pw-textarea"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            add();
          }
        }}
        placeholder={'Ran a 1,400-person developer conference\n62% of attendees were senior engineers\nBacked by Vercel and Notion'}
      />
      <button type="button" className="pw-btn-add" onClick={add} disabled={!text.trim()}>
        <Plus size={14} /> Add
      </button>

      {defaultCount > 0 && (
        <div className="pw-facts-toolbar">
          <span className="pw-facts-toolbar-label">
            <Sparkles size={11} /> {defaultCount} default fact{defaultCount === 1 ? '' : 's'} from your Context bank
          </span>
          <button
            type="button"
            className="pw-facts-clear"
            onClick={onClearDefaults}
            disabled={clearing}
          >
            {clearing ? <Loader2 className="pw-spin" size={12} /> : <X size={12} />} Clear defaults
          </button>
        </div>
      )}

      <ScopedChipList facts={facts} onRemove={handleRemove} />
    </div>
  );
}

/** Chip list that shows a person-scope indicator on extracted facts. */
function ScopedChipList({
  facts,
  onRemove,
}: {
  facts: FactItem[];
  onRemove: (i: number) => void;
}) {
  if (facts.length === 0) return <p className="pw-empty">No facts yet — add a few above.</p>;
  return (
    <div className="pw-chips">
      {facts.map((f, i) => (
        <span key={i} className={`pw-chip ${f.scope === 'person' ? 'pw-chip-person' : ''}`}>
          {f.scope === 'person' && <Sparkles size={10} className="pw-chip-scope-icon" />}
          {f.claim}
          <button type="button" className="pw-chip-x" aria-label="Remove" onClick={() => onRemove(i)}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

// Clarify (Stage 3) — adaptive questions from the onboard-questions agent.
function ClarifyStep({
  facts,
  addFact,
  ensurePersona,
}: {
  facts: FactItem[];
  addFact: (claim: string) => void;
  ensurePersona: () => Promise<string>;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    setLoading(true);
    setError(null);
    try {
      const pid = await ensurePersona(); // persist facts so the agent can read them
      const r = await agents.onboardQuestions(pid);
      setQuestions(r.questions);
      setAsked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate questions. You can skip this step.');
    } finally {
      setLoading(false);
    }
  }

  function saveAnswer(q: Question) {
    const a = answers[q.id]?.trim();
    if (!a) return;
    addFact(a); // becomes a persona fact on the next persist
    setAnswers((prev) => ({ ...prev, [q.id]: '' }));
    setQuestions((prev) => prev.filter((x) => x.id !== q.id));
  }

  return (
    <div className="pw-step">
      <StepHead
        q="Mind a few quick questions?"
        hint="The agent reads what you've added and asks only what fills the biggest gaps. Optional — answer what's useful, skip the rest."
      />
      {!asked && (
        <button type="button" className="pw-btn-add" onClick={ask} disabled={loading || facts.length === 0}>
          {loading ? <Loader2 className="pw-spin" size={14} /> : <Sparkles size={14} />}
          {loading ? 'Thinking…' : 'Ask me questions'}
        </button>
      )}
      {facts.length === 0 && !asked && (
        <p className="pw-empty">Add a fact or two on the previous step first — the questions adapt to you.</p>
      )}
      {error && <p className="pw-error">{error}</p>}
      <div className="pw-clar-list">
        {questions.map((q) => (
          <div key={q.id} className="pw-clar-q">
            <div className="pw-clar-question">{q.question}</div>
            <div className="pw-clar-why">{q.why}</div>
            <div className="pw-clar-row">
              <input
                className="pw-input"
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                placeholder="Your answer…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    saveAnswer(q);
                  }
                }}
              />
              <button type="button" className="pw-btn-add" onClick={() => saveAnswer(q)} disabled={!answers[q.id]?.trim()}>
                <Check size={14} />
              </button>
            </div>
          </div>
        ))}
        {asked && questions.length === 0 && (
          <p className="pw-empty">All caught up. Click Next to keep going.</p>
        )}
      </div>
    </div>
  );
}

function strictnessLabel(s: number): string {
  if (s <= 20) return 'Loose inspiration';
  if (s <= 45) return 'Mostly my own';
  if (s <= 70) return 'Balanced';
  if (s <= 90) return 'Follow closely';
  return 'Near-verbatim';
}

function StyleStep({
  exemplars,
  setExemplars,
  strictness,
  setStrictness,
}: {
  exemplars: ExItem[];
  setExemplars: React.Dispatch<React.SetStateAction<ExItem[]>>;
  strictness: number;
  setStrictness: React.Dispatch<React.SetStateAction<number>>;
}) {
  const [body, setBody] = useState('');
  function add() {
    if (!body.trim()) return;
    setExemplars((e) => [...e, { body: body.trim() }]);
    setBody('');
  }
  return (
    <div className="pw-step">
      <StepHead
        q="Show me how you write."
        hint="Paste a real email you've sent that landed well. Voice is learned from examples, not adjectives — one or two is plenty."
      />
      <textarea
        className="pw-input pw-textarea pw-textarea-tall"
        rows={7}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Paste a past email here…"
      />
      <button type="button" className="pw-btn-add" onClick={add} disabled={!body.trim()}>
        <Plus size={14} /> Add example
      </button>
      <div className="pw-ex-list">
        {exemplars.length === 0 && <p className="pw-empty">No examples yet — optional, but they sharpen the voice a lot.</p>}
        {exemplars.map((e, i) => (
          <div key={i} className="pw-ex">
            <p className="pw-ex-body">
              {e.body.slice(0, 220)}
              {e.body.length > 220 ? '…' : ''}
            </p>
            <button
              type="button"
              className="pw-ex-x"
              aria-label="Remove example"
              onClick={() => setExemplars((ex) => ex.filter((_, idx) => idx !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="pw-slider pw-strictness">
        <div className="pw-slider-top">
          <label htmlFor="pw-strictness-slider" className="pw-slider-label">
            How strictly should we follow these examples?
          </label>
          <span className="pw-strictness-value">{strictnessLabel(strictness)}</span>
        </div>
        <input
          id="pw-strictness-slider"
          className="pw-range"
          type="range"
          min={0}
          max={100}
          step={5}
          value={strictness}
          onChange={(e) => setStrictness(Number(e.target.value))}
          aria-valuetext={strictnessLabel(strictness)}
        />
        <div className="pw-slider-ends">
          <span>Loose — just borrow my voice</span>
          <span>Strict — reuse the structure</span>
        </div>
      </div>
    </div>
  );
}

// Calibrate (Stages 4–5) — we run the engine ONCE on a real contact (or a
// synthesized stand-in recipient when none exist yet) so the user reacts to a
// genuine draft instead of writing one. Two ways to refine:
//   • whole-draft chat (structural)
//   • highlight a span → a prompt box pops up right above it to rewrite just that.
// Every instruction is learned as taste (extract-style turns them into rules).
interface Recipient {
  name: string;
  role: string;
  company: string;
}
function CalibrateStep({
  subject,
  setSubject,
  body,
  setBody,
  instructions,
  setInstructions,
  ensurePersona,
}: {
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  instructions: string[];
  setInstructions: React.Dispatch<React.SetStateAction<string[]>>;
  ensurePersona: () => Promise<string>;
}) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-generated draft state.
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  // Whether the recipient is a synthesized stand-in (no real contacts yet).
  const [synthetic, setSynthetic] = useState(false);
  // 'idle' = not generated; 'ready' = a draft is on screen; 'failed' = the
  // engine couldn't draft (rare) → user can edit directly or regenerate.
  const [genState, setGenState] = useState<'idle' | 'failed' | 'ready'>('idle');

  // contentEditable body: uncontrolled DOM, synced to parent state via onInput.
  // We only push state INTO the DOM on programmatic replacement (bumping
  // bodyVersion) so typing never resets the caret.
  const editorRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [bodyVersion, setBodyVersion] = useState(0);
  useEffect(() => {
    if (editorRef.current && editorRef.current.innerText !== body) editorRef.current.innerText = body;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyVersion]);

  // Highlight → span-rewrite popover.
  const [popover, setPopover] = useState<{ text: string; top: number; left: number } | null>(null);
  const [spanInstruction, setSpanInstruction] = useState('');
  const [spanBusy, setSpanBusy] = useState(false);

  const generate = useCallback(async () => {
    setGenerating(true);
    setGenError(null);
    try {
      const pid = await ensurePersona();
      const data = await agents.calibrateDraft(pid);
      setRecipient(data.recipient);
      setSynthetic(Boolean(data.synthetic));
      setSubject(data.subject);
      setBody(data.body);
      setBodyVersion((v) => v + 1);
      setGenState('ready');
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Could not draft right now — edit below or regenerate.');
      setGenState('failed');
    } finally {
      setGenerating(false);
    }
  }, [ensurePersona, setSubject, setBody]);

  // Generate a draft on first entry (only if we don't already have one).
  const triedRef = useRef(false);
  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    if (body.trim()) {
      setGenState('ready');
      setBodyVersion((v) => v + 1);
    } else {
      generate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the current selection inside the body editor → anchor the popover
  // right above it. Runs on mouse/keyboard release inside the editor only, so
  // focusing the popover input (which collapses the selection) won't dismiss it.
  function syncSelection() {
    const sel = window.getSelection();
    const editor = editorRef.current;
    const canvas = canvasRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !editor || !canvas) {
      setPopover(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      setPopover(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      setPopover(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const box = canvas.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left - box.left + rect.width / 2, 70), box.width - 70);
    setPopover({ text, top: rect.top - box.top, left });
    setSpanInstruction('');
  }

  async function refine(opts: { span?: string; instruction: string }) {
    const instr = opts.instruction.trim();
    if (!instr || !body.trim()) return;
    const isSpan = Boolean(opts.span);
    if (isSpan) setSpanBusy(true);
    else setBusy(true);
    setError(null);
    try {
      const pid = await ensurePersona();
      const r = await agents.refine({ persona_id: pid, subject, body, instruction: instr, span: opts.span });
      setSubject(r.subject);
      setBody(r.body);
      setBodyVersion((v) => v + 1);
      setInstructions((prev) => [...prev, instr]);
      if (isSpan) {
        setPopover(null);
        setSpanInstruction('');
      } else {
        setInstruction('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refine failed — edit directly or try again.');
    } finally {
      setSpanBusy(false);
      setBusy(false);
    }
  }

  return (
    <div className="pw-step">
      <StepHead
        q="Let's calibrate on a real draft."
        hint="We drafted a real email from your voice. Tell the chat how to fix it — or highlight any part to rewrite just that bit. Every instruction is learned as your taste."
      />

      <div className="pw-calib-toolbar">
        {generating ? (
          <span className="pw-calib-meta">
            <Loader2 className="pw-spin" size={13} /> Drafting from your voice…
          </span>
        ) : recipient ? (
          <span className="pw-calib-meta">
            Drafted to <strong>{recipient.name}</strong>
            {recipient.company ? ` at ${recipient.company}` : ''}
            {synthetic ? ' · sample contact' : ''}
          </span>
        ) : genState === 'failed' ? (
          <span className="pw-calib-meta">Couldn't draft — edit below or regenerate.</span>
        ) : (
          <span className="pw-calib-meta" />
        )}
        <button type="button" className="pw-calib-regen" onClick={generate} disabled={generating}>
          {generating ? <Loader2 className="pw-spin" size={13} /> : <Sparkles size={13} />}
          {genState === 'ready' ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      {genError && <p className="pw-error">{genError}</p>}

      <input className="pw-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />

      <div className="pw-calib-canvas" ref={canvasRef}>
        <div
          ref={editorRef}
          className="pw-input pw-textarea pw-calib-editor"
          contentEditable={!generating}
          suppressContentEditableWarning
          data-placeholder="Draft body…"
          onInput={() => setBody(editorRef.current?.innerText ?? '')}
          onMouseUp={syncSelection}
          onKeyUp={syncSelection}
        />
        {popover && (
          <div className="pw-span-pop" style={{ top: popover.top, left: popover.left }}>
            <div className="pw-span-pop-bar">
              <input
                className="pw-span-pop-input"
                autoFocus
                value={spanInstruction}
                onChange={(e) => setSpanInstruction(e.target.value)}
                placeholder="Rewrite this part to…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    refine({ span: popover.text, instruction: spanInstruction });
                  } else if (e.key === 'Escape') {
                    setPopover(null);
                  }
                }}
              />
              <button
                type="button"
                className="pw-span-pop-go"
                onClick={() => refine({ span: popover.text, instruction: spanInstruction })}
                disabled={spanBusy || !spanInstruction.trim()}
              >
                {spanBusy ? <Loader2 className="pw-spin" size={13} /> : <Wand2 size={13} />}
              </button>
            </div>
            <div className="pw-span-pop-quote">“{popover.text.length > 80 ? popover.text.slice(0, 80) + '…' : popover.text}”</div>
          </div>
        )}
      </div>

      <div className="pw-calib-row">
        <input
          className="pw-input"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Fix the whole draft — e.g. make it less formal, cut the second paragraph"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              refine({ instruction });
            }
          }}
        />
        <button type="button" className="pw-btn-add" onClick={() => refine({ instruction })} disabled={busy || !body.trim() || !instruction.trim()}>
          {busy ? <Loader2 className="pw-spin" size={14} /> : <Wand2 size={14} />} Refine
        </button>
      </div>
      {instructions.length > 0 && (
        <div className="pw-chips">
          {instructions.map((c, i) => (
            <span key={i} className="pw-chip pw-chip-static">
              {c}
            </span>
          ))}
        </div>
      )}
      {error && <p className="pw-error">{error}</p>}
    </div>
  );
}

function OverviewStep({
  name,
  mode,
  facts,
  exemplars,
  persona,
  editing,
  onEdit,
}: {
  name: string;
  mode: MissionMode | null;
  facts: FactItem[];
  exemplars: ExItem[];
  persona: Persona | null;
  editing: boolean;
  onEdit: (s: Step) => void;
}) {
  return (
    <div className="pw-step pw-overview">
      <StepHead
        q={editing ? 'Your voice.' : "Here's your voice."}
        hint="Everything in one place. Tweak any section, then save — it's reusable across missions."
      />

      <OverviewRow
        title={name || 'Untitled voice'}
        sub={PURPOSES.find((p) => p.value === mode)?.label ?? 'No purpose set'}
        onEdit={() => onEdit('frame')}
      />

      <OverviewRow title="Substance" sub={`${facts.length} fact${facts.length === 1 ? '' : 's'}`} onEdit={() => onEdit('substance')}>
        {facts.length > 0 ? (
          <ul className="pw-ov-list">
            {facts.slice(0, 4).map((f, i) => (
              <li key={i}>{f.claim}</li>
            ))}
            {facts.length > 4 && <li className="pw-ov-more">+{facts.length - 4} more</li>}
          </ul>
        ) : (
          <p className="pw-empty">Nothing added.</p>
        )}
      </OverviewRow>

      <OverviewRow
        title="Writing samples"
        sub={`${exemplars.length} example${exemplars.length === 1 ? '' : 's'}`}
        onEdit={() => onEdit('style')}
      >
        {exemplars.length > 0 ? (
          <p className="pw-ov-snippet">
            {exemplars[0].body.slice(0, 160)}
            {exemplars[0].body.length > 160 ? '…' : ''}
          </p>
        ) : (
          <p className="pw-empty">No examples.</p>
        )}
      </OverviewRow>

      <OverviewRow title="Calibrated voice" onEdit={() => onEdit('calibrate')}>
        <VoiceProfile persona={persona} />
      </OverviewRow>
    </div>
  );
}

// The learned StyleProfile, made legible — the moat the engine reads at draft time.
function VoiceProfile({ persona }: { persona: Persona | null }) {
  const sp = persona?.style_profile;
  const dims = Object.entries(sp?.dimensions ?? {});
  if (!sp || (!sp.voice_summary && dims.length === 0)) {
    return <p className="pw-empty">Not calibrated yet — run a draft through Calibrate to learn your voice.</p>;
  }
  return (
    <div className="pw-voice">
      {sp.voice_summary && <p className="pw-ov-snippet">“{sp.voice_summary}”</p>}
      {dims.length > 0 && (
        <div className="pw-voice-dims">
          {dims.map(([n, d]) => (
            <div key={n} className="pw-voice-dim">
              <span className="pw-voice-dim-name">{n}</span>
              <span className="pw-voice-bar">
                <span className="pw-voice-bar-fill" style={{ width: `${Math.round((d.value ?? 0) * 100)}%` }} />
              </span>
            </div>
          ))}
        </div>
      )}
      {(sp.rules?.length ?? 0) > 0 && (
        <ul className="pw-ov-list">
          {sp.rules.slice(0, 3).map((r, i) => (
            <li key={i}>{r.rule}</li>
          ))}
        </ul>
      )}
      {(sp.banned_phrases?.length ?? 0) > 0 && (
        <div className="pw-chips">
          {sp.banned_phrases.map((p) => (
            <span key={p} className="pw-chip pw-chip-avoid">
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function OverviewRow({
  title,
  sub,
  onEdit,
  children,
}: {
  title: string;
  sub?: string;
  onEdit: () => void;
  children?: React.ReactNode;
}) {
  return (
    <section className="pw-ov-row">
      <div className="pw-ov-row-head">
        <div className="pw-ov-row-titles">
          <h3 className="pw-ov-title">{title}</h3>
          {sub && <span className="pw-ov-sub">{sub}</span>}
        </div>
        <button type="button" className="pw-ov-edit" onClick={onEdit}>
          <Pencil size={13} /> Edit
        </button>
      </div>
      {children && <div className="pw-ov-body">{children}</div>}
    </section>
  );
}

function ChipList({
  items,
  empty,
  onRemove,
}: {
  items: Array<{ key: number; label: string }>;
  empty: string;
  onRemove: (i: number) => void;
}) {
  if (items.length === 0) return <p className="pw-empty">{empty}</p>;
  return (
    <div className="pw-chips">
      {items.map((it) => (
        <span key={it.key} className="pw-chip">
          {it.label}
          <button type="button" className="pw-chip-x" aria-label="Remove" onClick={() => onRemove(it.key)}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}
