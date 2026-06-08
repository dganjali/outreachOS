import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { exportPipelineCsv } from '../lib/exportPipeline';
import type { Mission } from '../types';

function truncate(str: string, max: number) {
  if (str.length <= max) return str;
  return str.slice(0, max).trim() + '…';
}

const MODE_LABEL: Record<string, string> = {
  sponsorship: 'Sponsorship',
  bd: 'BD',
  internship: 'Internship',
  recruiting: 'Recruiting',
  sales: 'Sales',
};

interface MissionWithCounts extends Mission {
  target_count: number;
  draft_count: number;
}

export function Missions() {
  const { user } = useAuth();
  const [missions, setMissions] = useState<MissionWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      await exportPipelineCsv();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  async function load(uid: string, includeArchived: boolean) {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('missions')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (!includeArchived) query = query.is('archived_at', null);
      const { data: ms, error: qErr } = await query;
      if (qErr) throw qErr;
      const list = (ms ?? []) as Mission[];
      const withCounts = await Promise.all(
        list.map(async (m) => {
          const [{ count: tc }, { count: dc }] = await Promise.all([
            supabase.from('targets').select('id', { count: 'exact', head: true }).eq('mission_id', m.id),
            supabase.from('email_sequences').select('id', { count: 'exact', head: true }).eq('mission_id', m.id),
          ]);
          return { ...m, target_count: tc ?? 0, draft_count: dc ?? 0 };
        })
      );
      setMissions(withCounts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load missions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user?.id) return;
    load(user.id, showArchived);
  }, [user?.id, showArchived]);

  async function archive(e: React.MouseEvent, mission: MissionWithCounts) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Archive "${mission.name}"? You can restore it from the archived view.`)) return;
    await supabase.from('missions').update({ archived_at: new Date().toISOString() }).eq('id', mission.id);
    if (user?.id) load(user.id, showArchived);
  }

  async function restore(e: React.MouseEvent, mission: MissionWithCounts) {
    e.preventDefault();
    e.stopPropagation();
    await supabase.from('missions').update({ archived_at: null }).eq('id', mission.id);
    if (user?.id) load(user.id, showArchived);
  }

  return (
    <div>
      <header className="dashboard-header">
        <h1 style={{ margin: 0 }}>Missions</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            type="button"
            className="link-button"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
          <button type="button" className="btn-secondary" disabled={exporting} onClick={handleExport}>
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
          <Link to="/missions/new" className="dashboard-create">
            + Create Mission
          </Link>
        </div>
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="link-button" onClick={() => user?.id && load(user.id, showArchived)}>
            Retry
          </button>
        </div>
      ) : loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem' }}>Loading…</p>
      ) : missions.length === 0 ? (
        <div className="empty-illo">
          <div className="empty-illo-graphic" aria-hidden>🚀</div>
          <h3>No missions yet</h3>
          <p>
            A mission is one outreach campaign, a mode (sponsorship, BD, sales…), an offer, and an audience. Create one and the agents take it from there.
          </p>
          <Link to="/missions/new" className="dashboard-create" style={{ marginTop: '1.25rem' }}>
            Create your first mission
          </Link>
        </div>
      ) : (
        <div className="mission-cards">
          {missions.map((m) => (
            <Link key={m.id} to={`/missions/${m.id}`} className="mission-card">
              <div className="mission-card-top">
                <h3 className="mission-card-name">{m.name}</h3>
                <span className="mode-pill subtle">{MODE_LABEL[m.mode] ?? m.mode}</span>
              </div>
              <p className="mission-card-goal" title={m.goal}>
                {truncate(m.goal, 140)}
              </p>
              <div className="mission-card-stats">
                <span>{m.target_count} targets</span>
                <span>{m.draft_count} drafts</span>
                <span className={`status-pill status-${m.status}`}>{m.status}</span>
                {m.archived_at ? (
                  <button type="button" className="link-button" onClick={(e) => restore(e, m)}>
                    Restore
                  </button>
                ) : (
                  <button type="button" className="link-button" onClick={(e) => archive(e, m)}>
                    Archive
                  </button>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
