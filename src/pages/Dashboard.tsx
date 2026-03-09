import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { Mission } from '../types';

function truncate(str: string, max: number) {
  if (str.length <= max) return str;
  return str.slice(0, max).trim() + '…';
}

export function Dashboard() {
  const { user } = useAuth();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from('missions')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setMissions(data ?? []);
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  return (
    <div>
      <div className="dashboard-header">
        <h1>Dashboard</h1>
        <Link to="/missions/new" className="dashboard-create">
          Create Mission
        </Link>
      </div>

      <h2 className="missions-section-title">Your missions</h2>
      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9375rem' }}>Loading…</p>
      ) : missions.length === 0 ? (
        <div className="dashboard-empty">
          <p>No missions yet. Create a mission to define what you’re sending and who you want to reach.</p>
          <Link to="/missions/new" className="dashboard-create">
            Create your first mission
          </Link>
        </div>
      ) : (
        <div className="mission-cards">
          {missions.map((m) => (
            <Link key={m.id} to={`/missions/${m.id}`} className="mission-card">
              <h3 className="mission-card-name">{m.name}</h3>
              <p className="mission-card-meta">Status: {m.status}</p>
              <p className="mission-card-goal" title={m.goal}>
                {truncate(m.goal, 120)}
              </p>
            </Link>
          ))}
        </div>
      )}

      <section className="dashboard-activity" aria-label="Recent activity">
        <h2>Recent activity</h2>
        <p>Activity will appear here once you add missions and run outreach.</p>
      </section>
    </div>
  );
}
