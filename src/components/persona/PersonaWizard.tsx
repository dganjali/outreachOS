// PersonaWizard - the guided way to build a reusable voice.
//
// A voice is EMAIL STYLE ONLY (no offer/audience/proof - that's the mission).
// One screen per step: Frame → Style → Calibrate, then a single Overview that
// reveals the learned voice and lets you jump back to edit. Used standalone in
// ME → Personalization and embedded inside mission creation.
//
// LLM flow (Gemini agents, server-side):
//   • Calibrate → calibrate-draft: generate a real draft against a typed sample
//                 offer/audience (standalone), then refine: chat-edit it.
//   • Save      → extract-style: commits a confidence-weighted StyleProfile +
//                 the confirmed draft as a gold exemplar (+ version snapshot)
//
// Persistence is LAZY: the persona row is created the first time an agent needs
// it (Calibrate), so Frame/Style stay fully navigable and a user who bails early
// leaves at most an un-calibrated "Draft" (resumable). Every agent call degrades
// gracefully - failures show inline and never trap.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Wand2,
  X,
} from 'lucide-react';
import type { MissionMode, Persona } from '../../types';
import { useToast } from '../../context/ToastContext';
import { agents } from '../../lib/api';
import {
  addExemplar,
  createPersona,
  DEFAULT_TEMPLATE_STRICTNESS,
  deleteExemplar,
  emptyStyleProfile,
  getPersonaBundle,
  isPersonaCalibrated,
  updatePersona,
  type PersonaBundle,
} from '../../lib/personas';

// ---------------------------------------------------------------------------
// Local draft model
// ---------------------------------------------------------------------------
interface ExItem {
  id?: string;
  body: string;
}

type Step = 'frame' | 'style' | 'calibrate' | 'overview';
const INPUT_STEPS: Step[] = ['frame', 'style', 'calibrate'];

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
  /** Present = calibrate this voice against a specific mission (its real
   *  offer/audience + mission substance) instead of a typed sample. */
  missionId?: string;
  onDone: (persona: Persona) => void;
  onCancel?: () => void;
  /** Tweaks chrome when rendered inside the mission flow. */
  embedded?: boolean;
}

export function PersonaWizard({
  userId,
  personaId: initialPersonaId,
  seed,
  missionId,
  onDone,
  onCancel,
  embedded,
}: PersonaWizardProps) {
  const editing = Boolean(initialPersonaId);
  const toast = useToast();

  // frame
  const [name, setName] = useState('');
  const [mode, setMode] = useState<MissionMode | null>(seed?.mode ?? null);
  // style
  const [exemplars, setExemplars] = useState<ExItem[]>([]);
  // how strictly the engine should follow the exemplars as a template (0–100)
  const [strictness, setStrictness] = useState<number>(DEFAULT_TEMPLATE_STRICTNESS);
  // calibrate: a sample offer/audience the standalone draft is generated against
  // (a voice has no offer/audience of its own). Prefilled from the mission seed.
  const [sampleOffer, setSampleOffer] = useState(seed?.offer ?? '');
  const [sampleAudience, setSampleAudience] = useState(seed?.audience ?? '');
  const [calSubject, setCalSubject] = useState('');
  const [calBody, setCalBody] = useState('');
  const [calInstructions, setCalInstructions] = useState<string[]>([]);
  // The draft EXACTLY as the engine first generated it, before any hand-edits.
  // Diffed against the confirmed draft at commit time so manual edits (not just
  // chat instructions) are learned as taste/feedback.
  const calOriginalRef = useRef<{ subject: string; body: string } | null>(null);
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
    getPersonaBundle(userId, initialPersonaId)
      .then((b) => {
        if (!alive || !b) return;
        applyBundle(b);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load this voice'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPersonaId, userId]);

  function applyBundle(b: PersonaBundle) {
    personaIdRef.current = b.persona.id;
    setPersona(b.persona);
    setName(b.persona.name);
    setMode(b.persona.mode);
    setExemplars(b.exemplars.map((e) => ({ id: e.id, body: e.body })));
    setStrictness(b.persona.style_profile?.template_strictness ?? DEFAULT_TEMPLATE_STRICTNESS);
  }

  const go = useCallback((to: Step, direction: 'forward' | 'back') => {
    setDir(direction);
    setError(null);
    setStep(to);
  }, []);

  // ---- lazy persona create + persist pending exemplars (idempotent) ----
  const ensurePersona = useCallback(async (): Promise<string> => {
    let pid = personaIdRef.current;
    if (!pid) {
      const p = await createPersona(userId, { name: name.trim() || 'Untitled voice', mode });
      pid = p.id;
      personaIdRef.current = pid;
      setPersona(p);
    } else if (editing) {
      await updatePersona(pid, { name: name.trim() || 'Untitled voice', mode });
    }

    // Sync exemplars (the voice's writing samples) against DB truth.
    const before = await getPersonaBundle(userId, pid);
    if (before) {
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
      setExemplars(after.exemplars.map((e) => ({ id: e.id, body: e.body })));
      setPersona(after.persona);
    }
    return pid;
  }, [userId, name, mode, editing, exemplars, strictness]);

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
        // Persist the voice (exemplars + strictness) before calibrate needs it.
        setBusy(true);
        await ensurePersona();
        go('calibrate', 'forward');
      } else if (i >= 0 && i < INPUT_STEPS.length - 1) {
        go(INPUT_STEPS[i + 1], 'forward');
      } else {
        go('overview', 'forward');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong - try again.');
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
      // Capture any manual edits (the user hand-edited the generated draft
      // without telling the chat) as edit-deltas, so the learning loop sees
      // them as feedback alongside explicit instructions.
      const orig = calOriginalRef.current;
      const editDeltas: Array<{ original: string; final: string }> = [];
      if (orig) {
        if (orig.subject.trim() !== calSubject.trim()) {
          editDeltas.push({ original: orig.subject, final: calSubject });
        }
        if (orig.body.trim() !== calBody.trim()) {
          editDeltas.push({ original: orig.body, final: calBody });
        }
      }
      await agents.extractStyle({
        persona_id: pid,
        chat_instructions: calInstructions,
        ...(editDeltas.length ? { edit_deltas: editDeltas } : {}),
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
      setError(e instanceof Error ? e.message : 'Save failed - try again.');
      setBusy(false);
    }
  }

  const stepIndex = step === 'overview' ? INPUT_STEPS.length : INPUT_STEPS.indexOf(step);
  // Require a name with at least 2 characters so a voice is recognizable later,
  // not a stray keystroke like "h".
  const canNextFrame = name.trim().length >= 2 && mode != null;

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
              sampleOffer={sampleOffer}
              setSampleOffer={setSampleOffer}
              sampleAudience={sampleAudience}
              setSampleAudience={setSampleAudience}
              missionId={missionId}
              ensurePersona={ensurePersona}
              onGenerated={(d) => {
                calOriginalRef.current = d;
              }}
            />
          )}
          {step === 'overview' && (
            <OverviewStep
              name={name}
              mode={mode}
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
            <button type="button" className="pw-btn-primary" onClick={finish} disabled={busy || name.trim().length < 2}>
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
      <StepHead q="Let's name this voice." hint="A voice is a reusable way of writing - give it a name and tell us what it's for." />
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
        hint="Paste a real email you've sent that landed well. Voice is learned from examples, not adjectives - one or two is plenty."
      />
      <textarea
        className="pw-input pw-textarea pw-textarea-tall"
        rows={7}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Paste a past email here…"
      />
      <button
        type="button"
        className={`pw-btn-add${body.trim() ? ' pw-btn-add-ready' : ''}`}
        onClick={add}
        disabled={!body.trim()}
      >
        <Plus size={14} /> Add example
      </button>
      <div className="pw-ex-list">
        {exemplars.length === 0 && (
          <div className="pw-ex-empty">
            <Sparkles size={15} className="pw-ex-empty-icon" />
            <p className="pw-ex-empty-text">
              <strong>No examples yet.</strong> Optional — but even one real email sharpens the voice
              far more than any setting. Paste one above and hit <em>Add example</em>.
            </p>
          </div>
        )}
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
          <span>Loose - just borrow my voice</span>
          <span>Strict - reuse the structure</span>
        </div>
      </div>
    </div>
  );
}

// Calibrate (Stages 4–5) - we run the engine ONCE on a real contact (or a
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
  sampleOffer,
  setSampleOffer,
  sampleAudience,
  setSampleAudience,
  missionId,
  ensurePersona,
  onGenerated,
}: {
  subject: string;
  setSubject: (v: string) => void;
  body: string;
  setBody: (v: string) => void;
  instructions: string[];
  setInstructions: React.Dispatch<React.SetStateAction<string[]>>;
  sampleOffer: string;
  setSampleOffer: (v: string) => void;
  sampleAudience: string;
  setSampleAudience: (v: string) => void;
  /** When set, calibrate against this mission instead of the typed sample. */
  missionId?: string;
  ensurePersona: () => Promise<string>;
  onGenerated: (draft: { subject: string; body: string }) => void;
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
      const data = await agents.calibrateDraft(
        pid,
        missionId
          ? { mission_id: missionId }
          : { sample: { offer: sampleOffer.trim(), audience: sampleAudience.trim() } }
      );
      setRecipient(data.recipient);
      setSynthetic(Boolean(data.synthetic));
      setSubject(data.subject);
      setBody(data.body);
      setBodyVersion((v) => v + 1);
      // A regenerated draft is a clean slate - the prior refine instructions were
      // applied to the OLD draft and no longer hold, so clear the chips rather
      // than leave stale "applied" tags hanging over a fresh draft.
      setInstructions([]);
      // Remember the pristine generated draft so manual edits can be diffed.
      onGenerated({ subject: data.subject, body: data.body });
      setGenState('ready');
    } catch (e) {
      setGenError(e instanceof Error ? e.message : 'Could not draft right now - edit below or regenerate.');
      setGenState('failed');
    } finally {
      setGenerating(false);
    }
  }, [ensurePersona, setSubject, setBody, setInstructions, onGenerated, sampleOffer, sampleAudience, missionId]);

  // Generate a draft on first entry (only if we don't already have one).
  const triedRef = useRef(false);
  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    if (body.trim()) {
      setGenState('ready');
      setBodyVersion((v) => v + 1);
      // We re-entered with an existing draft - treat it as the baseline.
      onGenerated({ subject, body });
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
      // The refined output is the new machine baseline; the instruction itself
      // is already captured separately, so later hand-edits diff against this.
      onGenerated({ subject: r.subject, body: r.body });
      setInstructions((prev) => [...prev, instr]);
      if (isSpan) {
        setPopover(null);
        setSpanInstruction('');
      } else {
        setInstruction('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refine failed - edit directly or try again.');
    } finally {
      setSpanBusy(false);
      setBusy(false);
    }
  }

  return (
    <div className="pw-step">
      <StepHead
        q="Let's calibrate on a real draft."
        hint={
          missionId
            ? "We drafted a real email from your voice using this mission's offer and audience. Tell the chat how to fix it, or highlight any part to rewrite just that bit. Every instruction is learned as your taste."
            : "A voice is just how you write, so give a sample of what you'd be sending and to whom. We draft a real email from it - tell the chat how to fix it, or highlight any part to rewrite just that bit. Every instruction is learned as your taste."
        }
      />

      {!missionId && (
        <div className="pw-calib-sample">
          <label className="pw-field">
            <span className="pw-field-label">Sample offer (what you'd be sending)</span>
            <input
              className="pw-input"
              value={sampleOffer}
              onChange={(e) => setSampleOffer(e.target.value)}
              placeholder="e.g. sponsorship for a 500-person hackathon"
            />
          </label>
          <label className="pw-field">
            <span className="pw-field-label">Sample audience (who you'd reach)</span>
            <input
              className="pw-input"
              value={sampleAudience}
              onChange={(e) => setSampleAudience(e.target.value)}
              placeholder="e.g. heads of developer relations at infra startups"
            />
          </label>
          <p className="pw-field-hint">Just for calibration - this isn't saved to the voice. Your missions carry the real offer and audience.</p>
        </div>
      )}

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
          <span className="pw-calib-meta">Couldn't draft - edit below or regenerate.</span>
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
          placeholder="Fix the whole draft - e.g. make it less formal, cut the second paragraph"
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
        <div className="pw-chips-block">
          <span className="pw-chips-label">Applied to this draft · learned as your taste</span>
          <div className="pw-chips">
            {instructions.map((c, i) => (
              <span key={i} className="pw-chip pw-chip-static">
                {c}
              </span>
            ))}
          </div>
        </div>
      )}
      {error && <p className="pw-error">{error}</p>}
    </div>
  );
}

function OverviewStep({
  name,
  mode,
  exemplars,
  persona,
  editing,
  onEdit,
}: {
  name: string;
  mode: MissionMode | null;
  exemplars: ExItem[];
  persona: Persona | null;
  editing: boolean;
  onEdit: (s: Step) => void;
}) {
  return (
    <div className="pw-step pw-overview">
      <StepHead
        q={editing ? 'Your voice.' : "Here's your voice."}
        hint="Everything in one place. Tweak any section, then save - it's reusable across missions."
      />

      <OverviewRow
        title={name || 'Untitled voice'}
        sub={PURPOSES.find((p) => p.value === mode)?.label ?? 'No purpose set'}
        onEdit={() => onEdit('frame')}
      />

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

// The learned StyleProfile, made legible - the moat the engine reads at draft time.
function VoiceProfile({ persona }: { persona: Persona | null }) {
  const sp = persona?.style_profile;
  const dims = Object.entries(sp?.dimensions ?? {});
  const calibrated = isPersonaCalibrated(persona);
  // Only show "not calibrated" when the persona truly hasn't been through
  // Calibrate. Once a draft has been confirmed (onboarding completed), the
  // extractor can still be too conservative to emit dimensions/summary - so we
  // treat the persona as calibrated and show whatever voice signal we have.
  if (!calibrated && (!sp || (!sp.voice_summary && dims.length === 0))) {
    return <p className="pw-empty">Not calibrated yet - run a draft through Calibrate to learn your voice.</p>;
  }
  const summary = sp?.voice_summary?.trim() || 'Calibrated on your confirmed draft.';
  return (
    <div className="pw-voice">
      <p className="pw-ov-snippet">“{summary}”</p>
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
      {(sp?.rules?.length ?? 0) > 0 && (
        <ul className="pw-ov-list">
          {sp!.rules.slice(0, 3).map((r, i) => (
            <li key={i}>{r.rule}</li>
          ))}
        </ul>
      )}
      {(sp?.banned_phrases?.length ?? 0) > 0 && (
        <div className="pw-chips">
          {sp!.banned_phrases.map((p) => (
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
