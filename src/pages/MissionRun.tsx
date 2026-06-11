import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { agents } from '../lib/api';
import { asScore } from '../lib/score';
import type { Mission, Contact } from '../types';

type StepStatus = 'queued' | 'running' | 'done' | 'failed';
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

export function MissionRun() {
  const { id } = useParams<{ id: string }>();
  const [mission, setMission] = useState<Mission | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [note, setNote] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setStep = useCallback((tid: string, key: 'evidence' | 'contacts' | 'sequence', status: StepStatus) => {
    setTargets((ts) => ts.map((t) => (t.id === tid ? { ...t, [key]: status } : t)));
  }, []);

  // Elapsed clock, runs only during a live run.
  useEffect(() => {
    if (phase !== 'targeting' && phase !== 'running') return;
    const h = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(h);
  }, [phase]);

  // Load the mission (does NOT auto-run, the user launches deliberately).
  const [missionLoadError, setMissionLoadError] = useState<string | null>(null);
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
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [id]);

  // Client-driven orchestration. Each agent call is its own short request
  // (~4-7s on Gemini), so nothing trips Firebase Hosting's 60s proxy cap the
  // way a single long-lived /pipeline stream did. "Stop" sets the abort flag,
  // which we check between steps so an in-flight call finishes cleanly.
  const runPipeline = useCallback(
    async (m: Mission) => {
      setError(null);
      setElapsed(0);
      setTargets([]);
      setPhase('targeting');
      setNote('Finding high-fit companies with a reason to reach out now…');

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const stopped = () => ctrl.signal.aborted;
      const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
      // Two different 429s: the per-minute throttle just means "slow down",
      // the daily cap means stop for today. Only the latter pauses the run.
      const isDailyLimit = (e: unknown) => /daily/i.test(msgOf(e));
      const isRateLimit = (e: unknown) => /rate.?limit|\b429\b/i.test(msgOf(e));
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          ctrl.signal.addEventListener('abort', () => {
            clearTimeout(t);
            resolve();
          });
        });
      // Space agent calls so a 5/min deploy cap doesn't stall mid-pipeline.
      const pace = () => sleep(2_500);
      // Retry a step through transient minute-limit 429s (wait ~35s, twice).
      async function withMinuteRetry<T>(fn: () => Promise<T>, waitNote: string): Promise<T> {
        for (let attempt = 0; ; attempt++) {
          try {
            return await fn();
          } catch (e) {
            if (stopped() || isDailyLimit(e) || !isRateLimit(e) || attempt >= 2) throw e;
            setNote(waitNote);
            await sleep(35_000);
            if (stopped()) throw e;
          }
        }
      }

      try {
        // 1) Targets.
        const { targets: found } = await withMinuteRetry(
          () => agents.target(m.id, TARGET_COUNT),
          'Pacing requests, resuming in ~30s…'
        );
        if (stopped()) return;
        const top = [...found]
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, TOP_N);
        if (top.length === 0) {
          setNote('');
          return setPhase('done');
        }
        setTargets(
          top.map((t) => ({
            id: t.id,
            name: t.company_name,
            score: asScore(t.score),
            evidence: 'queued',
            contacts: 'queued',
            sequence: 'queued',
          }))
        );
        setPhase('running');

        // 2) Per target: evidence -> contacts -> best contact -> sequence.
        for (const t of top) {
          if (stopped()) return;
          await pace();

          setStep(t.id, 'evidence', 'running');
          setNote(`Researching ${t.company_name}, reading recent sources…`);
          try {
            await withMinuteRetry(() => agents.evidence(t.id), 'Pacing requests, resuming in ~30s…');
            setStep(t.id, 'evidence', 'done');
          } catch (e) {
            if (isDailyLimit(e)) return setPhase('paused');
            setStep(t.id, 'evidence', 'failed');
            continue;
          }
          if (stopped()) return;

          setStep(t.id, 'contacts', 'running');
          setNote(`Finding the right decision-makers at ${t.company_name}…`);
          let contacts: Contact[] = [];
          try {
            const r = await withMinuteRetry(() => agents.contacts(t.id), 'Pacing requests, resuming in ~30s…');
            contacts = r.contacts ?? [];
            setStep(t.id, 'contacts', 'done');
          } catch (e) {
            if (isDailyLimit(e)) return setPhase('paused');
            setStep(t.id, 'contacts', 'failed');
            continue;
          }
          const best = [...contacts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
          if (!best) {
            setStep(t.id, 'sequence', 'failed');
            continue;
          }
          if (stopped()) return;

          setStep(t.id, 'sequence', 'running');
          setNote(`Drafting a personalized email for ${t.company_name}…`);
          try {
            await withMinuteRetry(() => agents.sequence(best.id), 'Pacing requests, resuming in ~30s…');
            setStep(t.id, 'sequence', 'done');
          } catch (e) {
            if (isDailyLimit(e)) return setPhase('paused');
            setStep(t.id, 'sequence', 'failed');
          }
        }

        if (stopped()) return;
        setNote('');
        setPhase('done');
      } catch (err) {
        if (stopped()) return;
        if (isDailyLimit(err)) return setPhase('paused');
        setError(err instanceof Error ? err.message : 'Pipeline failed');
        setPhase('error');
      }
    },
    [setStep]
  );

  const totalSteps = targets.length > 0 ? 1 + targets.length * 3 : 1;
  const doneSteps =
    (phase !== 'ready' && phase !== 'targeting' ? 1 : 0) +
    targets.reduce(
      (n, t) => n + (t.evidence === 'done' ? 1 : 0) + (t.contacts === 'done' ? 1 : 0) + (t.sequence === 'done' ? 1 : 0),
      0
    );
  const pct = Math.min(100, Math.round((doneSteps / totalSteps) * 100));
  const draftsReady = targets.filter((t) => t.sequence === 'done').length;
  const isLive = phase === 'targeting' || phase === 'running';

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
            and draft a personalized email per target, live, below. You review and send after.
          </p>
          <p className="run-ready-fineprint">
            Runs live in this tab; keep it open until it finishes (about a minute). Finished targets are saved as you go. Uses up to ~{1 + TOP_N * 3} of your daily agent runs.
          </p>
          {missionLoadError && (
            <p className="run-banner error" role="alert">
              {missionLoadError} <Link to="/missions">Back to missions</Link>
            </p>
          )}
          <button
            type="button"
            className="launchpad-cta"
            disabled={!mission}
            onClick={() => mission && runPipeline(mission)}
          >
            {mission ? 'Launch pipeline →' : missionLoadError ? 'Unavailable' : 'Loading…'}
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
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                abortRef.current?.abort();
                setPhase('canceled');
              }}
            >
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
          {error ?? 'The run failed.'}{' '}
          <button type="button" className="link-button" onClick={() => mission && runPipeline(mission)}>
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
