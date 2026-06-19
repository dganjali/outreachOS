import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { pipeline, type ContactTypeOptionView, type PipelineRunView, type PipelineStepStatus } from '../lib/api';
import { asScore } from '../lib/score';
import { LogoMark } from '../components/Logo';
import type { Mission } from '../types';

type StepStatus = PipelineStepStatus;
type Phase = 'ready' | 'targeting' | 'running' | 'done' | 'paused' | 'error' | 'canceled';

interface RunTarget {
  id: string;
  name: string;
  score: number | null;
  evidence: StepStatus;
  contacts: StepStatus;
  sequence: StepStatus;
  sequences: StepStatus[];
}

const DEFAULT_COMPANIES = 5;
const MIN_COMPANIES = 1;
const MAX_COMPANIES = 15;
const DEFAULT_CONTACTS = 1;
const MIN_CONTACTS = 1;
const MAX_CONTACTS = 5;
const POLL_MS = 2000;

// The launch screen exposes one knob - how many companies to pursue (= top_n,
// the ones we research, find contacts for, and draft). We discover a larger
// pool than we pursue so ranking has something to choose from.
function targetCountFor(companies: number): number {
  return Math.min(Math.max(companies * 2, companies + 3), 25);
}

// Map the server run's status/phase onto the UI phase the view already speaks.
function phaseOf(run: PipelineRunView | null): Phase {
  if (!run) return 'ready';
  switch (run.status) {
    case 'pending':
      return 'targeting';
    case 'running':
      return run.phase === 'targeting' ? 'targeting' : 'running';
    case 'paused':
      return 'paused';
    case 'done':
      return 'done';
    case 'error':
      return 'error';
    case 'canceled':
      return 'canceled';
    default:
      return 'running';
  }
}

// The server now writes each step's status directly (including 'running' while a
// step is in flight), so the view reads per-target status as-is. Because targets
// are processed in parallel, several can show 'running' at once.
function targetsOf(run: PipelineRunView | null): RunTarget[] {
  if (!run) return [];
  return run.targets.map((t) => ({
    id: t.target_id,
    name: t.name,
    score: asScore(t.score),
    evidence: t.evidence,
    contacts: t.contacts,
    sequence: t.sequence,
    sequences: t.sequences ?? [],
  }));
}

export function MissionRun() {
  const { id } = useParams<{ id: string }>();
  const [mission, setMission] = useState<Mission | null>(null);
  const [run, setRun] = useState<PipelineRunView | null>(null);
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [missionLoadError, setMissionLoadError] = useState<string | null>(null);
  const [companies, setCompanies] = useState(DEFAULT_COMPANIES);
  const [contacts, setContacts] = useState(DEFAULT_CONTACTS);
  const [priorRun, setPriorRun] = useState<PipelineRunView | null>(null);
  const [typeOpts, setTypeOpts] = useState<{
    functions: ContactTypeOptionView[];
    seniority: ContactTypeOptionView[];
    sectors: ContactTypeOptionView[];
  } | null>(null);
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [selectedSectors, setSelectedSectors] = useState<Set<string>>(new Set());
  const runIdRef = useRef<string | null>(null);

  const phase = phaseOf(run);
  const targets = targetsOf(run);
  const isLive = phase === 'targeting' || phase === 'running';
  const note = run?.note ?? '';

  // Load the mission, and rehydrate any run already in flight for it (so a
  // closed/reopened tab rejoins the live run instead of starting over).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    supabase
      .from('missions')
      .select('*')
      .eq('id', id)
      .single()
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setMissionLoadError(err.message);
        else if (!data) setMissionLoadError('Mission not found.');
        else setMission(data as Mission);
      });
    pipeline
      .latestForMission(id)
      .then(({ data }) => {
        if (cancelled || !data) return;
        setPriorRun(data);
        // Reuse the settings from the last run so a re-run defaults to the same
        // size (clamped to the control's range).
        if (data.config?.top_n) {
          setCompanies(Math.min(Math.max(data.config.top_n, MIN_COMPANIES), MAX_COMPANIES));
        }
        if (data.config?.top_contacts) {
          setContacts(Math.min(Math.max(data.config.top_contacts, MIN_CONTACTS), MAX_CONTACTS));
        }
        // Only auto-attach to a still-relevant run; a long-finished one stays
        // on the pre-launch screen so the user can deliberately relaunch.
        if (data.status === 'pending' || data.status === 'running' || data.status === 'paused') {
          runIdRef.current = data.id;
          setRun(data);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Ask the AI for the menu of contact types to reach out to (functions +
  // seniority, derived from the mission's ICP), then pre-check the recommended
  // ones. If it fails we just don't show the section and run unfiltered.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    pipeline
      .contactTypes(id)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const normalized = {
          functions: data.functions ?? [],
          seniority: data.seniority ?? [],
          sectors: data.sectors ?? [],
        };
        setTypeOpts(normalized);
        const recommendedPeople = [...normalized.functions, ...normalized.seniority]
          .filter((o) => o.recommended)
          .map((o) => o.id);
        const recommendedSectors = normalized.sectors
          .filter((o) => o.recommended)
          .map((o) => o.id);
        setSelectedPeople(new Set(recommendedPeople));
        setSelectedSectors(new Set(recommendedSectors));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id]);

  const togglePeople = useCallback((optId: string) => {
    setSelectedPeople((prev) => {
      const next = new Set(prev);
      if (next.has(optId)) next.delete(optId);
      else next.add(optId);
      return next;
    });
  }, []);

  const toggleSector = useCallback((optId: string) => {
    setSelectedSectors((prev) => {
      const next = new Set(prev);
      if (next.has(optId)) next.delete(optId);
      else next.add(optId);
      return next;
    });
  }, []);

  // Elapsed clock - derived from the run's start, ticks only while live.
  useEffect(() => {
    if (!run) return;
    const base = new Date(run.started_at).getTime();
    const compute = () => {
      const end = run.completed_at ? new Date(run.completed_at).getTime() : Date.now();
      setElapsed(Math.max(0, Math.round((end - base) / 1000)));
    };
    compute();
    if (!isLive) return;
    const h = setInterval(compute, 1000);
    return () => clearInterval(h);
  }, [run, isLive]);

  // Poll the server run while it's live. The server is the source of truth and
  // self-heals a stalled driver on each poll, so this is all the client needs.
  // Keyed on id+status only, so steady-state polling keeps one stable timer.
  //
  // The poll clock lives in a Web Worker, not a main-thread setInterval: a
  // hidden tab throttles main-thread timers to ~1/min, which would starve both
  // this UI and the Cloud Run driver the poll keeps warm (the driver only gets
  // CPU while a request is in flight). Worker timers aren't throttled, so the
  // run keeps advancing while the tab is backgrounded - as long as it stays open.
  const liveStatus = run?.status === 'pending' || run?.status === 'running';
  useEffect(() => {
    if (!liveStatus) return;
    let cancelled = false;

    const poll = async () => {
      const rid = runIdRef.current;
      if (!rid) return;
      try {
        const { data } = await pipeline.status(rid);
        if (!cancelled && data) setRun(data);
      } catch {
        /* transient - keep polling */
      }
    };

    const worker = new Worker(new URL('../workers/poll-timer.ts', import.meta.url), { type: 'module' });
    worker.onmessage = () => void poll();
    worker.postMessage({ type: 'start', intervalMs: POLL_MS });

    // Snap to the latest state the instant the tab is refocused, rather than
    // waiting for the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    return () => {
      cancelled = true;
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [liveStatus]);

  const launch = useCallback(async () => {
    if (!mission) return;
    setError(null);
    setStarting(true);
    try {
      const chosen = typeOpts
        ? [...typeOpts.functions, ...typeOpts.seniority].filter((o) => selectedPeople.has(o.id))
        : [];
      const fns = chosen.filter((o) => o.kind === 'function').map((o) => o.value);
      const sens = chosen.filter((o) => o.kind === 'seniority').map((o) => o.value);
      const sectors = typeOpts ? (typeOpts.sectors ?? []).filter((o) => selectedSectors.has(o.id)).map((o) => o.value) : [];
      const { data } = await pipeline.start(
        mission.id,
        targetCountFor(companies),
        companies,
        contacts,
        fns,
        sens,
        sectors
      );
      runIdRef.current = data.id;
      setRun(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the pipeline.');
    } finally {
      setStarting(false);
    }
  }, [mission, companies, contacts, typeOpts, selectedPeople, selectedSectors]);

  const stop = useCallback(async () => {
    const rid = runIdRef.current;
    if (!rid) return;
    try {
      await pipeline.cancel(rid);
      const { data } = await pipeline.status(rid);
      setRun(data);
    } catch {
      /* ignore */
    }
  }, []);

  const totalSteps = targets.length > 0 ? 1 + targets.length * 3 : 1;
  const targetingDone = run && run.phase !== 'targeting' ? 1 : 0;
  const doneSteps =
    targetingDone +
    targets.reduce(
      (n, t) =>
        n + (t.evidence === 'done' ? 1 : 0) + (t.contacts === 'done' ? 1 : 0) + (t.sequence === 'done' ? 1 : 0),
      0
    );
  const pct = Math.min(100, Math.round((doneSteps / totalSteps) * 100));
  const draftsReady = targets.filter((t) => t.sequence === 'done').length;

  // ---- Ready (pre-launch) ----
  if (phase === 'ready') {
    return (
      <div className="run-view">
        <Link to={`/missions/${id}`} className="mission-detail-back">
          ← Mission
        </Link>
        <div className="run-ready">
          <div className="run-ready-icon" aria-hidden><LogoMark size={28} variant="mono-light" /></div>
          <h1 className="run-title">
            {mission ? `${priorRun ? 'Run' : 'Launch'} ${mission.name}${priorRun ? ' again' : ''}?` : 'Launch pipeline?'}
          </h1>
          <p className="run-ready-body">
            The agent will find {companies} {companies === 1 ? 'company' : 'companies'}, research each,
            surface the right {contacts === 1 ? 'contact' : `${contacts} contacts`}, and draft a personalized
            email for {contacts === 1 ? 'them' : 'each'}. You review and send after.
          </p>

          <div className="run-config">
            <label className="run-config-label" htmlFor="run-companies">Companies to pursue</label>
            <div className="run-stepper" role="group" aria-label="Companies to pursue">
              <button
                type="button"
                className="run-stepper-btn"
                aria-label="Fewer companies"
                disabled={companies <= MIN_COMPANIES}
                onClick={() => setCompanies((c) => Math.max(MIN_COMPANIES, c - 1))}
              >
                −
              </button>
              <input
                id="run-companies"
                type="number"
                className="run-stepper-value"
                min={MIN_COMPANIES}
                max={MAX_COMPANIES}
                value={companies}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setCompanies(Math.min(MAX_COMPANIES, Math.max(MIN_COMPANIES, n)));
                }}
              />
              <button
                type="button"
                className="run-stepper-btn"
                aria-label="More companies"
                disabled={companies >= MAX_COMPANIES}
                onClick={() => setCompanies((c) => Math.min(MAX_COMPANIES, c + 1))}
              >
                +
              </button>
            </div>
          </div>

          <div className="run-config">
            <label className="run-config-label" htmlFor="run-contacts">Contacts per company</label>
            <div className="run-stepper" role="group" aria-label="Contacts per company">
              <button
                type="button"
                className="run-stepper-btn"
                aria-label="Fewer contacts"
                disabled={contacts <= MIN_CONTACTS}
                onClick={() => setContacts((c) => Math.max(MIN_CONTACTS, c - 1))}
              >
                −
              </button>
              <input
                id="run-contacts"
                type="number"
                className="run-stepper-value"
                min={MIN_CONTACTS}
                max={MAX_CONTACTS}
                value={contacts}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (Number.isFinite(n)) setContacts(Math.min(MAX_CONTACTS, Math.max(MIN_CONTACTS, n)));
                }}
              />
              <button
                type="button"
                className="run-stepper-btn"
                aria-label="More contacts"
                disabled={contacts >= MAX_CONTACTS}
                onClick={() => setContacts((c) => Math.min(MAX_CONTACTS, c + 1))}
              >
                +
              </button>
            </div>
          </div>

          {typeOpts && (typeOpts.functions.length > 0 || typeOpts.seniority.length > 0 || typeOpts.sectors.length > 0) && (
            <div className="run-targeting-controls">
              {(typeOpts.functions.length > 0 || typeOpts.seniority.length > 0) && (
                <PickerPanel
                  title="Types of people"
                  subtitle="Teams, roles, and seniority to prioritize inside each company."
                >
                  {typeOpts.functions.length > 0 && (
                    <ContactTypeGroup
                      label="Teams & functions"
                      options={typeOpts.functions}
                      selected={selectedPeople}
                      onToggle={togglePeople}
                    />
                  )}
                  {typeOpts.seniority.length > 0 && (
                    <ContactTypeGroup
                      label="Seniority"
                      options={typeOpts.seniority}
                      selected={selectedPeople}
                      onToggle={togglePeople}
                    />
                  )}
                </PickerPanel>
              )}
              {typeOpts.sectors.length > 0 && (
                <PickerPanel
                  title="Types of companies"
                  subtitle="Sectors to strongly bias company discovery toward."
                >
                  <ContactTypeGroup
                    label="Sectors"
                    options={typeOpts.sectors}
                    selected={selectedSectors}
                    onToggle={toggleSector}
                  />
                </PickerPanel>
              )}
            </div>
          )}

          {priorRun && (
            <p className="run-ready-note">
              You've already run this mission. Running again finds <strong>new</strong> companies -
              we skip ones already in this mission.
            </p>
          )}

          <p className="run-ready-fineprint">
            Keep this tab open while it runs - you can switch to other tabs. Progress is saved as it
            goes. Uses up to ~{1 + companies * (2 + contacts)} of your daily agent runs.
          </p>
          {missionLoadError && (
            <p className="run-banner error" role="alert">
              {missionLoadError} <Link to="/missions">Back to missions</Link>
            </p>
          )}
          {error && (
            <p className="run-banner error" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className="launchpad-cta"
            disabled={!mission || starting}
            onClick={launch}
          >
            {starting
              ? 'Starting…'
              : mission
                ? priorRun
                  ? 'Run again →'
                  : 'Launch pipeline →'
                : missionLoadError
                  ? 'Unavailable'
                  : 'Loading…'}
          </button>
        </div>
      </div>
    );
  }

  // ---- Running / terminal ----
  return (
    <div className="run-view">
      <Link to={`/missions/${id}`} className="mission-detail-back">
        ← Mission
      </Link>

      <header className="run-head">
        <div className="run-head-main">
          <h1 className="run-title">{mission?.name ?? 'Mission'}</h1>
          <p className="run-subtitle">
            {phase === 'done'
              ? 'Pipeline complete.'
              : phase === 'paused'
                ? 'Paused, daily limit reached.'
                : phase === 'canceled'
                  ? 'Stopped. Finished targets are saved.'
                  : phase === 'error'
                    ? 'Something went wrong.'
                    : 'Researching your pipeline…'}
          </p>
        </div>
        <div className="run-head-meta">
          <span className="run-clock">{fmt(elapsed)}</span>
          {isLive && (
            <button type="button" className="btn-secondary" onClick={stop}>
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="run-progress">
        <div className="run-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      <div className="run-progress-meta">
        <span>{doneSteps} of {totalSteps} steps</span>
        {isLive && note && <span className="run-note">{note}</span>}
      </div>

      {phase === 'paused' && (
        <div className="run-banner warn">
          You've hit your daily agent-run limit. The finished targets below are ready to use; the rest
          resume tomorrow. <Link to={`/missions/${id}`}>Go to mission</Link>
        </div>
      )}
      {phase === 'error' && (
        <div className="run-banner error">
          {run?.error ?? error ?? 'The run failed.'}{' '}
          <button type="button" className="link-button" onClick={launch}>
            Retry
          </button>
        </div>
      )}

      <div className="run-phase">
        <StepDot status={phase === 'targeting' ? 'running' : 'done'} />
        <span className="run-phase-label">
          {targets.length > 0 ? `Found ${targets.length} companies to pursue` : 'Finding companies…'}
        </span>
      </div>

      {targets.length > 0 && (
        <ul className="run-targets">
          {targets.map((t) => {
            const score = asScore(t.score);
            return (
              <li key={t.id} className={`run-target ${t.sequence === 'done' ? 'ready' : ''}`}>
                <div className="run-target-name">
                  {t.name}
                  {score != null && <span className="run-target-score">{score}</span>}
                </div>
                <div className="run-target-steps">
                  <StepChip label="Evidence" status={t.evidence} />
                  <StepChip label="Contacts" status={t.contacts} />
                  <StepChip label={draftLabel(t)} status={t.sequence} />
                </div>
                {t.sequence === 'done' && (
                  <Link to={`/missions/${id}`} className="run-target-review">
                    Review →
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(phase === 'done' || phase === 'canceled') && (
        <div className="run-summary">
          <div className="run-summary-stat">
            <strong>{draftsReady}</strong> draft{draftsReady === 1 ? '' : 's'} ready
            {targets.length > draftsReady ? ` · ${targets.length - draftsReady} incomplete` : ''}
          </div>
          <Link to={`/missions/${id}`} className="launchpad-cta">
            Review &amp; send →
          </Link>
        </div>
      )}
    </div>
  );
}

// "Draft" for a single contact; "Drafts n/m" once several are in flight so the
// per-company contact count is visible as it progresses.
function draftLabel(t: RunTarget): string {
  if (t.sequences.length <= 1) return 'Draft';
  const done = t.sequences.filter((s) => s === 'done').length;
  return `Drafts ${done}/${t.sequences.length}`;
}

function PickerPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="run-picker-panel">
      <div className="run-picker-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

// Toggle-chip group of targeting options.
function ContactTypeGroup({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: ContactTypeOptionView[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="run-types-group">
      <span className="run-types-label">{label}</span>
      <div className="run-chip-grid">
        {options.map((o) => {
          const on = selected.has(o.id);
          return (
            <button
              key={o.id}
              type="button"
              className={`run-type-chip ${on ? 'is-on' : ''}`}
              onClick={() => onToggle(o.id)}
              aria-pressed={on}
            >
              <span className="run-type-check" aria-hidden>
                {on ? <Check size={13} /> : null}
              </span>
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepChip({ label, status }: { label: string; status: StepStatus }) {
  const icon = status === 'done' ? '✓' : status === 'failed' ? '!' : '·';
  return (
    <span className={`step-chip step-${status}`}>
      <span className="step-chip-icon">{status === 'running' ? <span className="step-spin" /> : icon}</span>
      {label}
    </span>
  );
}

function StepDot({ status }: { status: StepStatus }) {
  return <span className={`step-dot step-${status}`}>{status === 'done' ? '✓' : ''}</span>;
}

function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
