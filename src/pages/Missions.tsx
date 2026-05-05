import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
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

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    async function load() {
      const { data: ms } = await supabase
        .from('missions')
        .select('*')
        .eq('user_id', user!.id)
        .order('created_at', { ascending: false });
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
      if (cancelled) return;
      setMissions(withCounts);
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return (
    <div>
      <header className="dashboard-header">
        <h1 style={{ margin: 0 }}>Missions</h1>
        <Link to="/missions/new" className="dashboard-create">
          + Create Mission
        </Link>
      </header>

      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem' }}>Loading…</p>
      ) : missions.length === 0 ? (
        <div className="empty-illo">
          <div className="empty-illo-graphic" aria-hidden>🚀</div>
          <h3>No missions yet</h3>
          <p>
            A mission is one outreach campaign — a mode (sponsorship, BD, sales…), an offer, and an audience. Create one and the agents take it from there.
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
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
