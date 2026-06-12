import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { pipeline, type PipelineRunView, type PipelineStepStatus } from '../lib/api';
import { asScore } from '../lib/score';
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
}

const TOP_N = 5;
const TARGET_COUNT = 8;
const POLL_MS = 2000;

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

// The server stores step status as queued/done/failed; the in-flight step is
// derived from the run cursor so we can render it as "running" live.
function targetsOf(run: PipelineRunView | null): RunTarget[] {
  if (!run) return [];
  return run.targets.map((t, i) => {
    const live = run.status === 'running' && run.cursor?.target_index === i;
    const mark = (step: 'evidence' | 'contacts' | 'sequence'): StepStatus =>
      live && run.cursor?.step === step && t[step] === 'queued' ? 'running' : t[step];
    return {
      id: t.target_id,
      name: t.name,
      score: asScore(t.score),
      evidence: mark('evidence'),
      contacts: mark('contacts'),
      sequence: mark('sequence'),
    };
  });
}

export function MissionRun() {
  const { id } = useParams<{ id: string }>();
  const [mission, setMission] = useState<Mission | null>(null);
  const [run, setRun] = useState<PipelineRunView | null>(null);
  const [starting, setStarting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [missionLoadError, setMissionLoadError] = useState<string | null>(null);
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

  // Elapsed clock — derived from the run's start, ticks only while live.
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
  const liveStatus = run?.status === 'pending' || run?.status === 'running';
  useEffect(() => {
    if (!liveStatus) return;
    let cancelled = false;
    const h = setInterval(async () => {
      const rid = runIdRef.current;
      if (!rid) return;
      try {
        const { data } = await pipeline.status(rid);
        if (!cancelled && data) setRun(data);
      } catch {
        /* transient — keep polling */
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [liveStatus]);

  const launch = useCallback(async () => {
    if (!mission) return;
    setError(null);
    setStarting(true);
    try {
      const { data } = await pipeline.start(mission.id, TARGET_COUNT, TOP_N);
      runIdRef.current = data.id;
      setRun(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the pipeline.');
    } finally {
      setStarting(false);
    }
  }, [mission]);

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
          <div className="run-ready-icon" aria-hidden>✦</div>
          <h1 className="run-title">{mission ? `Launch ${mission.name}?` : 'Launch pipeline?'}</h1>
          <p className="run-ready-body">
            The agent will find the top {TOP_N} companies, research each, surface the right contacts,
            and draft a personalized email per target. You review and send after.
          </p>
          <p className="run-ready-fineprint">
            Runs on the server — you can close this tab and come back; progress is saved as it goes.
            Uses up to ~{1 + TOP_N * 3} of your daily agent runs.
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
            {starting ? 'Starting…' : mission ? 'Launch pipeline →' : missionLoadError ? 'Unavailable' : 'Loading…'}
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
                  <StepChip label="Draft" status={t.sequence} />
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
