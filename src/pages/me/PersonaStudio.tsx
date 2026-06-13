// Persona studio — the ME → Voice tab. The taste-onboarding home and the
// "your voice" legibility surface in one place:
//   • pick / create a persona (reusable voice)
//   • Substance: context facts (who you are) — Stage 2
//   • Exemplars: gold emails (carry the voice) — Stage 1
//   • Clarify: adaptive questions from gaps — Stage 3 (onboard-questions agent)
//   • Calibrate: write a sample, chat-refine it, confirm — Stages 4–5
//     (refine + extract-style agents → confidence-weighted StyleProfile)
//   • Your voice: the learned StyleProfile, per-dimension confidence, rules,
//     banned phrases, exemplar count, version — the moat made legible.
//
// Calibration here is contact-free (it runs in ME); the same refine canvas is
// reused on real drafts in MissionPage at runtime.

import { useCallback, useEffect, useState } from 'react';
import { Plus, Sparkles, Check, Wand2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { agents } from '../../lib/api';
import {
  listPersonas,
  createPersona,
  getPersona,
  listContextFacts,
  addContextFact,
  listExemplars,
  addExemplar,
} from '../../lib/personas';
import type { Persona, ContextFact, StyleExemplar } from '../../types';

export function PersonaStudio({ userId }: { userId: string | undefined }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshPersonas = useCallback(async () => {
    if (!userId) return;
    const ps = await listPersonas(userId);
    setPersonas(ps);
    setActiveId((cur) => cur ?? ps[0]?.id ?? null);
  }, [userId]);

  useEffect(() => {
    refreshPersonas().catch((e) => setError(e instanceof Error ? e.message : 'load failed'));
  }, [refreshPersonas]);

  const active = personas.find((p) => p.id === activeId) ?? null;

  async function handleCreate() {
    if (!userId || !newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await createPersona(userId, { name: newName });
      setPersonas((prev) => [...prev, p]);
      setActiveId(p.id);
      setNewName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    } finally {
      setBusy(false);
    }
  }

  // Re-pull a single persona after calibration so the "your voice" surface updates.
  const reloadActive = useCallback(async () => {
    if (!activeId) return;
    const fresh = await getPersona(activeId);
    if (fresh) setPersonas((prev) => prev.map((p) => (p.id === fresh.id ? fresh : p)));
  }, [activeId]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Label>Voice (persona)</Label>
        <div className="flex flex-wrap items-center gap-2">
          {personas.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setActiveId(p.id)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                activeId === p.id
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:text-foreground'
              }`}
            >
              {p.name}
              {p.onboarding_completed_at ? ' ✓' : ''}
            </button>
          ))}
          <div className="flex items-center gap-1.5">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New persona…"
              className="h-8 w-40"
            />
            <Button type="button" size="sm" variant="outline" disabled={busy || !newName.trim()} onClick={handleCreate}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {active && userId ? (
        <PersonaDetail key={active.id} userId={userId} persona={active} onCalibrated={reloadActive} />
      ) : (
        <p className="text-sm text-muted-foreground">Create a persona to start building its voice.</p>
      )}
    </div>
  );
}

function PersonaDetail({
  userId,
  persona,
  onCalibrated,
}: {
  userId: string;
  persona: Persona;
  onCalibrated: () => void;
}) {
  const [facts, setFacts] = useState<ContextFact[]>([]);
  const [exemplars, setExemplars] = useState<StyleExemplar[]>([]);

  const reload = useCallback(async () => {
    const [f, e] = await Promise.all([listContextFacts(userId, persona.id), listExemplars(persona.id)]);
    setFacts(f);
    setExemplars(e);
  }, [userId, persona.id]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <YourVoiceCard persona={persona} exemplarCount={exemplars.length} />
      <SubstanceCard userId={userId} personaId={persona.id} facts={facts} onAdded={reload} />
      <ExemplarsCard userId={userId} personaId={persona.id} exemplars={exemplars} onAdded={reload} />
      <ClarifyCard userId={userId} personaId={persona.id} onAnswered={reload} />
      <div className="lg:col-span-2">
        <CalibrateCard persona={persona} onCalibrated={onCalibrated} />
      </div>
    </div>
  );
}

// ---- Your voice (legibility surface) ----
function YourVoiceCard({ persona, exemplarCount }: { persona: Persona; exemplarCount: number }) {
  const sp = persona.style_profile;
  const dims = Object.entries(sp?.dimensions ?? {});
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Your voice</h3>
        <span className="text-xs text-muted-foreground">v{persona.style_profile_version}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {sp?.voice_summary || 'Not calibrated yet — add exemplars and run a calibration below.'}
      </p>
      {dims.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {dims.map(([name, d]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs capitalize text-muted-foreground">{name}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(d.value * 100)}%` }} />
              </div>
              <span className="w-10 shrink-0 text-right text-[10px] text-muted-foreground" title="confidence">
                {Math.round(d.confidence * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
      {(sp?.rules?.length ?? 0) > 0 && (
        <div className="mt-3">
          <div className="text-xs font-medium text-foreground">Rules</div>
          <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
            {sp.rules.map((r, i) => (
              <li key={i}>{r.rule}</li>
            ))}
          </ul>
        </div>
      )}
      {(sp?.banned_phrases?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {sp.banned_phrases.map((p) => (
            <span key={p} className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
              {p}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 text-xs text-muted-foreground">{exemplarCount} exemplar(s)</div>
    </section>
  );
}

// ---- Substance (context facts) ----
function SubstanceCard({
  userId,
  personaId,
  facts,
  onAdded,
}: {
  userId: string;
  personaId: string;
  facts: ContextFact[];
  onAdded: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      // Each line becomes an atomic, citable fact (the grounding universe).
      for (const line of draft.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        await addContextFact(userId, { claim: line, type: 'proof', scope: 'person', provenance: 'answer' });
      }
      setDraft('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Substance</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Atomic facts the engine may cite — proof, metrics, credentials. One per line.
      </p>
      <ul className="mt-2 max-h-32 overflow-auto text-xs text-muted-foreground">
        {facts.map((f) => (
          <li key={f.id} className="border-b border-border/50 py-1">
            <span className="mr-1 rounded bg-secondary px-1 text-[10px] uppercase">{f.type}</span>
            {f.claim}
          </li>
        ))}
        {facts.length === 0 && <li className="py-1 italic">No facts yet.</li>}
      </ul>
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="Ran a 1,400-person dev conference&#10;62% of attendees were senior engineers"
        className="mt-2"
      />
      <Button type="button" size="sm" variant="outline" className="mt-2" disabled={busy || !draft.trim()} onClick={add}>
        <Plus className="mr-1 h-4 w-4" /> Add facts
      </Button>
    </section>
  );
}

// ---- Exemplars ----
function ExemplarsCard({
  userId,
  personaId,
  exemplars,
  onAdded,
}: {
  userId: string;
  personaId: string;
  exemplars: StyleExemplar[];
  onAdded: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await addExemplar(userId, personaId, { body });
      setBody('');
      onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Exemplars</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Real emails you wrote that worked. Voice is carried by examples, not adjectives.
      </p>
      <ul className="mt-2 max-h-32 overflow-auto text-xs text-muted-foreground">
        {exemplars.map((e) => (
          <li key={e.id} className="border-b border-border/50 py-1">
            {e.body.slice(0, 90)}
            {e.body.length > 90 ? '…' : ''}
          </li>
        ))}
        {exemplars.length === 0 && <li className="py-1 italic">No exemplars yet.</li>}
      </ul>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder="Paste a past email that landed well…"
        className="mt-2"
      />
      <Button type="button" size="sm" variant="outline" className="mt-2" disabled={busy || !body.trim()} onClick={add}>
        <Plus className="mr-1 h-4 w-4" /> Add exemplar
      </Button>
    </section>
  );
}

// ---- Clarifying questions (Stage 3) ----
function ClarifyCard({
  userId,
  personaId,
  onAnswered,
}: {
  userId: string;
  personaId: string;
  onAnswered: () => void;
}) {
  const [questions, setQuestions] = useState<Array<{ id: string; question: string; why: string }>>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const r = await agents.onboardQuestions(personaId);
      setQuestions(r.questions);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  }

  async function saveAnswer(qid: string) {
    const a = answers[qid]?.trim();
    if (!a) return;
    await addContextFact(userId, { claim: a, type: 'proof', scope: 'persona', personaId, provenance: 'answer' });
    setAnswers((prev) => ({ ...prev, [qid]: '' }));
    setQuestions((prev) => prev.filter((q) => q.id !== qid));
    onAnswered();
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Clarify</h3>
        <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={generate}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="mr-1 h-4 w-4" />}
          {loading ? '' : 'Ask me'}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">Adaptive questions that fill the biggest gaps.</p>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      <div className="mt-2 flex flex-col gap-3">
        {questions.map((q) => (
          <div key={q.id}>
            <div className="text-xs font-medium text-foreground">{q.question}</div>
            <div className="text-[10px] text-muted-foreground">{q.why}</div>
            <div className="mt-1 flex gap-1.5">
              <Input
                value={answers[q.id] ?? ''}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                className="h-8"
                placeholder="Your answer…"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => saveAnswer(q.id)}>
                <Check className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
        {questions.length === 0 && !loading && (
          <p className="text-xs italic text-muted-foreground">No open questions. Click “Ask me”.</p>
        )}
      </div>
    </section>
  );
}

// ---- Calibrate (Stages 4–5): write → chat-refine → confirm ----
function CalibrateCard({ persona, onCalibrated }: { persona: Persona; onCalibrated: () => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [instruction, setInstruction] = useState('');
  const [chatInstructions, setChatInstructions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmedMsg, setConfirmedMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refine() {
    if (!body.trim() || !instruction.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await agents.refine({ persona_id: persona.id, subject, body, instruction });
      setSubject(r.subject);
      setBody(r.body);
      setChatInstructions((prev) => [...prev, instruction.trim()]);
      setInstruction('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'refine failed');
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // Confirmed draft → gold exemplar; chat instructions → conservative rules.
      const r = await agents.extractStyle({
        persona_id: persona.id,
        chat_instructions: chatInstructions,
        confirmed_exemplar: { subject: subject || null, body },
        source: 'onboarding',
      });
      setConfirmedMsg(`Committed StyleProfile v${r.style_profile_version}.`);
      setChatInstructions([]);
      onCalibrated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'confirm failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-semibold text-foreground">Calibrate</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Write (or paste) a draft, then tell the chat how to fix it — every instruction is learned as taste. Confirm to
        save a gold exemplar and conservative rules.
      </p>
      <Input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        className="mt-2"
      />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Draft body…"
        className="mt-2"
      />
      <div className="mt-2 flex gap-1.5">
        <Input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. make it less formal, cut the second paragraph"
        />
        <Button type="button" variant="outline" disabled={busy || !body.trim() || !instruction.trim()} onClick={refine}>
          <Wand2 className="mr-1 h-4 w-4" /> Refine
        </Button>
      </div>
      {chatInstructions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chatInstructions.map((c, i) => (
            <span key={i} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {c}
            </span>
          ))}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {confirmedMsg && <p className="mt-2 text-xs text-emerald-500">{confirmedMsg}</p>}
      <Button type="button" className="mt-3 font-semibold" disabled={busy || !body.trim()} onClick={confirm}>
        {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Check className="mr-1 h-4 w-4" />}
        Confirm & commit voice
      </Button>
    </section>
  );
}
