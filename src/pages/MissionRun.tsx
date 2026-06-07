import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { agents } from '../lib/api';
import type { Mission, Target, Contact } from '../types';

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
  const canceledRef = useRef(false);

  const setStep = useCallback((tid: string, key: 'evidence' | 'contacts' | 'sequence', status: StepStatus) => {
    setTargets((ts) => ts.map((t) => (t.id === tid ? { ...t, [key]: status } : t)));
  }, []);

  // Elapsed clock — runs only during a live run.
  useEffect(() => {
    if (phase !== 'targeting' && phase !== 'running') return;
    const h = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(h);
  }, [phase]);

  // Load the mission (does NOT auto-run — the user launches deliberately).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    supabase
      .from('missions')
      .select('*')
      .eq('id', id)
      .single()
      .then(({ data }) => {
        if (!cancelled && data) setMission(data as Mission);
      });
    return () => {
      cancelled = true;
      canceledRef.current = true;
    };
  }, [id]);

  const runPipeline = useCallback(
    async (m: Mission) => {
      canceledRef.current = false;
      setError(null);
      setElapsed(0);
      try {
        setPhase('targeting');
        setNote('Finding high-fit companies with a reason to reach out now…');

        const { data: existingData } = await supabase.from('targets').select('*').eq('mission_id', m.id);
        let working = (existingData ?? []) as Target[];
        if (working.length === 0) {
          const r = await agents.target(m.id, TARGET_COUNT);
          working = (r.targets ?? []) as Target[];
        }
        if (canceledRef.current) return;

        const top = working
          .slice()
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, TOP_N);

        if (top.length === 0) {
          setNote('');
          setPhase('done');
          return;
        }

        setTargets(
          top.map((t) => ({
            id: t.id,
            name: t.company_name,
            score: t.score ?? null,
            evidence: 'queued',
            contacts: 'queued',
            sequence: 'queued',
          }))
        );
        setPhase('running');

        for (const t of top) {
          if (canceledRef.current) return setPhase('canceled');
          try {
            setStep(t.id, 'evidence', 'running');
            setNote(`Researching ${t.company_name} — reading recent sources…`);
            await agents.evidence(t.id);
            setStep(t.id, 'evidence', 'done');

            if (canceledRef.current) return setPhase('canceled');
            setStep(t.id, 'contacts', 'running');
            setNote(`Finding the right decision-makers at ${t.company_name}…`);
            const cr = await agents.contacts(t.id);
            setStep(t.id, 'contacts', 'done');

            const topContact = (cr.contacts ?? [])
              .slice()
              .sort((a: Contact, b: Contact) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];

            if (topContact) {
              if (canceledRef.current) return setPhase('canceled');
              setStep(t.id, 'sequence', 'running');
              setNote(`Drafting a personalized email for ${t.company_name}…`);
              await agents.sequence(topContact.id);
              setStep(t.id, 'sequence', 'done');
            } else {
              setStep(t.id, 'sequence', 'failed');
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            if (/rate_limit/i.test(msg)) return setPhase('paused');
            setTargets((ts) =>
              ts.map((x) =>
                x.id === t.id
                  ? {
                      ...x,
                      evidence: x.evidence === 'running' ? 'failed' : x.evidence,
                      contacts: x.contacts === 'running' ? 'failed' : x.contacts,
                      sequence: x.sequence === 'running' ? 'failed' : x.sequence,
                    }
                  : x
              )
            );
          }
        }

        setNote('');
        setPhase('done');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Pipeline failed';
        if (/rate_limit/i.test(msg)) return setPhase('paused');
        setError(msg);
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
            and draft a personalized email per target — live, below. You review and send after.
          </p>
          <p className="run-ready-fineprint">Uses up to ~{1 + TOP_N * 3} of your daily agent runs · takes a few minutes.</p>
          <button
            type="button"
            className="launchpad-cta"
            disabled={!mission}
            onClick={() => mission && runPipeline(mission)}
          >
            Launch pipeline →
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
                ? 'Paused — daily limit reached.'
                : phase === 'canceled'
                  ? 'Stopped.'
                  : phase === 'error'
                    ? 'Something went wrong.'
                    : 'Researching your pipeline…'}
          </p>
        </div>
        <div className="run-head-meta">
          <span className="run-clock">⏱ {fmt(elapsed)}</span>
          {isLive && (
            <button type="button" className="btn-secondary" onClick={() => { canceledRef.current = true; setPhase('canceled'); }}>
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
          {targets.map((t) => (
            <li key={t.id} className={`run-target ${t.sequence === 'done' ? 'ready' : ''}`}>
              <div className="run-target-name">
                {t.name}
                {typeof t.score === 'number' && <span className="run-target-score">{t.score}</span>}
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
          ))}
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
