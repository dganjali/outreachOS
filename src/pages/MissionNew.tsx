import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';

export function MissionNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
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
    navigate(data ? `/missions/${data.id}` : '/missions', { replace: true });
  }

  return (
    <div>
      <Link to="/missions" className="mission-detail-back">
        ← Missions
      </Link>
      <h1>Create Mission</h1>
      <p style={{ margin: '0 0 1.5rem', fontSize: '0.9375rem', color: 'var(--text-muted)' }}>
        Define what you’re sending and who you want to reach. You can add the rest later.
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
          <label htmlFor="mission-what">What you’re sending</label>
          <textarea
            id="mission-what"
            value={whatSending}
            onChange={(e) => setWhatSending(e.target.value)}
            placeholder="Describe your offer, pitch, or message — e.g. sponsorship tiers, partnership proposal, internship opportunity."
            required
          />
        </div>
        <div className="field">
          <label htmlFor="mission-who">Who you want to send it to (the why)</label>
          <textarea
            id="mission-who"
            value={whoAndWhy}
            onChange={(e) => setWhoAndWhy(e.target.value)}
            placeholder="General idea of your audience and why they’re a fit — e.g. dev tools with active communities, HR leads at Series B, hackathon organizers."
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
