import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { MissionMode } from '../types';

const MODES: Array<{ value: MissionMode; label: string; hint: string }> = [
  { value: 'sponsorship', label: 'Sponsorship', hint: 'Get companies to sponsor an event/community' },
  { value: 'bd', label: 'BD / Partnerships', hint: 'Land integration or partnership deals' },
  { value: 'internship', label: 'Internship / Job', hint: 'Land a role at a target org' },
  { value: 'recruiting', label: 'Recruiting', hint: 'Source candidates for an open role' },
  { value: 'sales', label: 'Cold Sales', hint: 'Sell a product or service' },
];

export function MissionNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isWelcome = params.get('welcome') === '1';
  const [name, setName] = useState('');
  const [mode, setMode] = useState<MissionMode>('sponsorship');
  const [whatSending, setWhatSending] = useState('');
  const [whoAndWhy, setWhoAndWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const { data, error: err } = await supabase
      .from('missions')
      .insert({
        user_id: user!.id,
        name: name.trim(),
        mode,
        goal: whatSending.trim(),
        target_description: whoAndWhy.trim(),
        status: 'active',
      })
      .select('id')
      .single();
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    navigate(data ? `/missions/${data.id}/run` : '/missions', { replace: true });
  }

  return (
    <div>
      <Link to="/missions" className="mission-detail-back">
        ← Missions
      </Link>
      <h1>{isWelcome ? 'Create your first mission' : 'Create Mission'}</h1>
      <p style={{ margin: '0 0 1.5rem', fontSize: '0.9375rem', color: 'var(--text-muted)' }}>
        {isWelcome
          ? "You're all set. A mission tells the agent who you're trying to reach and what you're offering, fill it in and we'll find targets, contacts, and draft emails for you."
          : "Pick a mode, define what you're sending, and describe who you want to reach. The agent will do the rest."}
      </p>

      <form onSubmit={handleSubmit} className="mission-form">
        <div className="field">
          <label htmlFor="mission-name">Mission name</label>
          <input
            id="mission-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q1 sponsorship outreach"
            required
          />
        </div>

        <div className="field">
          <label>Mode</label>
          <div className="mode-grid">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                className={`mode-card ${mode === m.value ? 'selected' : ''}`}
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
              >
                <span className="mode-card-label">{m.label}</span>
                <span className="mode-card-hint">{m.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label htmlFor="mission-what">What you're sending / your offer</label>
          <textarea
            id="mission-what"
            value={whatSending}
            onChange={(e) => setWhatSending(e.target.value)}
            placeholder="Be specific. e.g. 'Sponsorship tiers $5k–25k for Hack the North 2026 (1.4k attendees, 60% senior CS).'"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="mission-who">Who you want to reach (the why)</label>
          <textarea
            id="mission-who"
            value={whoAndWhy}
            onChange={(e) => setWhoAndWhy(e.target.value)}
            placeholder="e.g. 'Dev tools companies with active student programs and recent hackathon sponsorships in 2025.'"
            required
          />
        </div>
        <div className="mission-form-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create mission'}
          </button>
          <Link to="/missions" className="btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
      {error && <p role="alert" style={{ marginTop: '1rem', color: 'var(--error)', fontSize: '0.875rem' }}>{error}</p>}
    </div>
  );
}
