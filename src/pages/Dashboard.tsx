import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { gmail } from '../lib/api';
import type { Mission, AgentRun } from '../types';

interface Stats {
  missions: number;
  drafts: number;
  contacted: number;
  replied: number;
  repliesToHandle: number;
  runsToday: number;
}

interface MissionWithStats extends Mission {
  target_count: number;
  contact_count: number;
  draft_count: number;
}

const RUN_LABEL: Record<string, string> = {
  targeting: 'Researched targets',
  contacts: 'Found contacts',
  evidence: 'Built an evidence pack',
  sequence: 'Drafted a sequence',
  reply: 'Classified a reply',
  enrich_profile: 'Enriched your profile',
  coach: 'Coached a profile field',
  parse_resume: 'Parsed a résumé',
};

// Fields that make a profile "sharp enough" for good drafts.
const PROFILE_FIELDS = ['name', 'role', 'bio', 'proof_points', 'achievements', 'metrics', 'linkedin_url', 'writing_tone'] as const;

function profileCompleteness(profile: Record<string, unknown> | null | undefined): number {
  if (!profile) return 0;
  const filled = PROFILE_FIELDS.filter((f) => {
    const v = profile[f];
    return typeof v === 'string' && v.trim().length > 0;
  }).length;
  return Math.round((filled / PROFILE_FIELDS.length) * 100);
}

export function Dashboard() {
  const { user, profile } = useAuth();
  const [missions, setMissions] = useState<MissionWithStats[]>([]);
  const [stats, setStats] = useState<Stats>({
    missions: 0,
    drafts: 0,
    contacted: 0,
    replied: 0,
    repliesToHandle: 0,
    runsToday: 0,
  });
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchRuns = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from('agent_runs')
      .select('*')
      .eq('user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(8);
    setRuns((data ?? []) as AgentRun[]);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const [
        { data: msData },
        { count: draftCount },
        { count: contactedCount },
        { count: repliedCount },
        { count: repliesToHandle },
        { count: runsToday24h },
        { data: runsData },
      ] = await Promise.all([
        supabase
          .from('missions')
          .select('*')
          .eq('user_id', user!.id)
          .is('archived_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('email_sequences').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'contacted'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'replied'),
        supabase.from('replies').select('id', { count: 'exact', head: true }).eq('handled', false),
        supabase.from('agent_runs').select('id', { count: 'exact', head: true }).gte('started_at', dayAgo),
        supabase.from('agent_runs').select('*').eq('user_id', user!.id).order('started_at', { ascending: false }).limit(8),
      ]);

      if (cancelled) return;

      const missionsList = (msData ?? []) as Mission[];

      const missionsWithStats: MissionWithStats[] = await Promise.all(
        missionsList.map(async (m) => {
          const [{ count: tc }, { data: targetIds }] = await Promise.all([
            supabase.from('targets').select('id', { count: 'exact', head: true }).eq('mission_id', m.id),
            supabase.from('targets').select('id').eq('mission_id', m.id),
          ]);
          const ids = (targetIds ?? []).map((r) => r.id as string);
          let cc = 0;
          let dc = 0;
          if (ids.length > 0) {
            const [{ count: c1 }, { count: c2 }] = await Promise.all([
              supabase.from('contacts').select('id', { count: 'exact', head: true }).in('target_id', ids),
              supabase.from('email_sequences').select('id', { count: 'exact', head: true }).eq('mission_id', m.id),
            ]);
            cc = c1 ?? 0;
            dc = c2 ?? 0;
          }
          return { ...m, target_count: tc ?? 0, contact_count: cc, draft_count: dc };
        })
      );

      if (cancelled) return;

      setMissions(missionsWithStats);
      setStats({
        missions: missionsList.length,
        drafts: draftCount ?? 0,
        contacted: contactedCount ?? 0,
        replied: repliedCount ?? 0,
        repliesToHandle: repliesToHandle ?? 0,
        runsToday: runsToday24h ?? 0,
      });
      setRuns((runsData ?? []) as AgentRun[]);
      setLoading(false);

      // First-run only needs Gmail status (for the setup nudge).
      if (missionsList.length === 0) {
        gmail
          .status()
          .then((r) => !cancelled && setGmailConnected(r.connected))
          .catch(() => !cancelled && setGmailConnected(null));
      }
    }

    load().catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id, reloadKey]);

  // Keep the activity feed honest: while any run is in flight, re-poll until it
  // reaches a terminal state (fixes phantom "RUNNING" rows that never resolve).
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const anyRunning = runs.some((r) => r.status === 'running');
    if (!anyRunning) return;
    pollRef.current = setTimeout(() => {
      void refetchRuns();
    }, 4000);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [runs, refetchRuns]);

  const responseRate = stats.contacted > 0 ? Math.round((stats.replied / stats.contacted) * 100) : null;
  const firstName = profile?.name ? profile.name.split(' ')[0] : null;
  const percent = profileCompleteness(profile as unknown as Record<string, unknown>);

  // ---- First-run launchpad ----
  if (!loading && missions.length === 0) {
    return (
      <div className="launchpad">
        <section className="launchpad-card">
          <p className="launchpad-eyebrow">Welcome{firstName ? `, ${firstName}` : ''} 👋</p>
          <h1 className="launchpad-title">Let's land your first reply.</h1>
          <p className="launchpad-sub">
            Tell us who you want to reach. The agent finds the companies, the right people, the angle,
            and writes the emails — you just review and send.
          </p>
          <Link to="/missions/new" className="launchpad-cta">
            Start your first mission →
          </Link>

          <div className="launchpad-nudges">
            {gmailConnected === false && (
              <Link to="/settings" className="launchpad-nudge">
                <span className="launchpad-nudge-dot" aria-hidden />
                Connect Gmail <em>so you can send</em>
              </Link>
            )}
            <Link to="/me" className="launchpad-nudge">
              <span className="launchpad-nudge-dot" aria-hidden />
              Sharpen your profile <em>{percent}% complete</em>
            </Link>
          </div>
        </section>

        <div className="launchpad-steps" aria-hidden>
          <LaunchStep n={1} title="Find targets" body="High-fit companies with a real reason to reach out now." />
          <LaunchStep n={2} title="Research & contacts" body="Sourced evidence + the decision-makers to email." />
          <LaunchStep n={3} title="Drafts ready" body="A personalized sequence per contact, ready to send." />
        </div>
      </div>
    );
  }

  // ---- Active dashboard ----
  return (
    <div>
      <header className="dashboard-header">
        <div>
          <h1 style={{ margin: 0 }}>{firstName ? `Welcome back, ${firstName}` : 'Dashboard'}</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Your outreach pipeline at a glance.
          </p>
        </div>
        <Link to="/missions/new" className="dashboard-create">
          + New mission
        </Link>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="link-button" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </button>
        </div>
      )}

      <div className="kpi-grid">
        <KPI label="Missions" value={stats.missions} />
        <KPI label="Drafts to review" value={stats.drafts} to={stats.drafts > 0 ? '/missions' : undefined} highlight={stats.drafts > 0} />
        <KPI label="Replies to handle" value={stats.repliesToHandle} to={stats.repliesToHandle > 0 ? '/inbox' : undefined} highlight={stats.repliesToHandle > 0} />
        <KPI label="Contacted" value={stats.contacted} />
        <KPI label="Reply rate" value={responseRate === null ? '—' : `${responseRate}%`} />
        <KPI label="Runs today" value={`${stats.runsToday}/50`} highlight={stats.runsToday >= 40} />
      </div>

      <div className="dashboard-columns">
        <section className="dashboard-section">
          <h2>Active missions</h2>
          {loading ? (
            <div className="skeleton-list">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : (
            <ul className="mission-row-list">
              {missions.map((m) => {
                const pct = m.target_count > 0 ? Math.round((m.draft_count / m.target_count) * 100) : 0;
                return (
                  <li key={m.id}>
                    <Link to={`/missions/${m.id}`} className="mission-row">
                      <div className="mission-row-main">
                        <strong>{m.name}</strong>
                        <span className="mode-pill subtle">{m.mode}</span>
                      </div>
                      <div className="mission-progress" aria-hidden>
                        <div className="mission-progress-bar" style={{ width: `${Math.min(pct, 100)}%` }} />
                      </div>
                      <div className="mission-row-stats">
                        <span>{m.target_count} targets</span>
                        <span>{m.contact_count} contacts</span>
                        <span>{m.draft_count} drafts</span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="dashboard-section">
          <h2>Recent activity</h2>
          {runs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
              Nothing yet. Run a mission to see activity here.
            </p>
          ) : (
            <ul className="run-list">
              {runs.map((r) => (
                <li key={r.id} className={`run-item run-${r.status}`}>
                  <span className="run-type">{RUN_LABEL[r.agent_type] ?? r.agent_type}</span>
                  <span className={`run-status status-${r.status}`}>
                    {r.status === 'running' ? 'running…' : r.status}
                  </span>
                  <span className="run-time">{timeAgo(r.started_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function KPI({ label, value, to, highlight }: { label: string; value: number | string; to?: string; highlight?: boolean }) {
  const inner = (
    <>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
    </>
  );
  if (to) {
    return (
      <Link to={to} className={`kpi-card kpi-link ${highlight ? 'kpi-highlight' : ''}`}>
        {inner}
      </Link>
    );
  }
  return <div className={`kpi-card ${highlight ? 'kpi-highlight' : ''}`}>{inner}</div>;
}

function LaunchStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="launch-step">
      <div className="launch-step-num">{n}</div>
      <div>
        <div className="launch-step-title">{title}</div>
        <div className="launch-step-body">{body}</div>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
