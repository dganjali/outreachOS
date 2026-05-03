import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { Mission, AgentRun } from '../types';

interface Stats {
  missions: number;
  targets: number;
  contacts: number;
  drafts: number;
  contacted: number;
  replied: number;
}

interface MissionWithStats extends Mission {
  target_count: number;
  contact_count: number;
  draft_count: number;
}

const RUN_LABEL: Record<string, string> = {
  targeting: 'Targeting',
  contacts: 'Contact graph',
  evidence: 'Evidence',
  sequence: 'Sequence',
};

export function Dashboard() {
  const { user, profile } = useAuth();
  const [missions, setMissions] = useState<MissionWithStats[]>([]);
  const [stats, setStats] = useState<Stats>({
    missions: 0,
    targets: 0,
    contacts: 0,
    drafts: 0,
    contacted: 0,
    replied: 0,
  });
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;

    async function load() {
      const [
        { data: msData },
        { count: targetCount },
        { count: contactCount },
        { count: draftCount },
        { count: contactedCount },
        { count: repliedCount },
        { data: runsData },
      ] = await Promise.all([
        supabase
          .from('missions')
          .select('*')
          .eq('user_id', user!.id)
          .order('created_at', { ascending: false }),
        supabase.from('targets').select('id', { count: 'exact', head: true }),
        supabase.from('contacts').select('id', { count: 'exact', head: true }),
        supabase.from('email_sequences').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'contacted'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'replied'),
        supabase
          .from('agent_runs')
          .select('*')
          .eq('user_id', user!.id)
          .order('started_at', { ascending: false })
          .limit(10),
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
        targets: targetCount ?? 0,
        contacts: contactCount ?? 0,
        drafts: draftCount ?? 0,
        contacted: contactedCount ?? 0,
        replied: repliedCount ?? 0,
      });
      setRuns((runsData ?? []) as AgentRun[]);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const responseRate =
    stats.contacted > 0 ? Math.round((stats.replied / stats.contacted) * 100) : null;

  return (
    <div>
      <header className="dashboard-header">
        <div>
          <h1 style={{ margin: 0 }}>
            {profile?.name ? `Welcome back, ${profile.name.split(' ')[0]}` : 'Dashboard'}
          </h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Your outreach pipeline at a glance.
          </p>
        </div>
        <Link to="/missions/new" className="dashboard-create">
          + Create Mission
        </Link>
      </header>

      <div className="kpi-grid">
        <KPI label="Missions" value={stats.missions} />
        <KPI label="Targets" value={stats.targets} />
        <KPI label="Contacts" value={stats.contacts} />
        <KPI label="Drafts" value={stats.drafts} />
        <KPI label="Contacted" value={stats.contacted} />
        <KPI label="Reply rate" value={responseRate === null ? '—' : `${responseRate}%`} />
      </div>

      <div className="dashboard-columns">
        <section className="dashboard-section">
          <h2>Active missions</h2>
          {loading ? (
            <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
          ) : missions.length === 0 ? (
            <div className="empty-card">
              <p>No missions yet. Create one to start finding targets and drafting outreach.</p>
              <Link to="/missions/new" className="dashboard-create">
                Create your first mission
              </Link>
            </div>
          ) : (
            <ul className="mission-row-list">
              {missions.map((m) => (
                <li key={m.id}>
                  <Link to={`/missions/${m.id}`} className="mission-row">
                    <div className="mission-row-main">
                      <strong>{m.name}</strong>
                      <span className="mode-pill subtle">{m.mode}</span>
                    </div>
                    <div className="mission-row-stats">
                      <span>{m.target_count} targets</span>
                      <span>{m.contact_count} contacts</span>
                      <span>{m.draft_count} drafts</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dashboard-section">
          <h2>Recent activity</h2>
          {runs.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
              Nothing yet. Run an agent on a mission to see activity here.
            </p>
          ) : (
            <ul className="run-list">
              {runs.map((r) => (
                <li key={r.id} className={`run-item run-${r.status}`}>
                  <span className="run-type">{RUN_LABEL[r.agent_type] ?? r.agent_type}</span>
                  <span className={`run-status status-${r.status}`}>{r.status}</span>
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

function KPI({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
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
