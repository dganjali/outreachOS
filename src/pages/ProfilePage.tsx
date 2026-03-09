import { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { Profile } from '../types';

export function ProfilePage() {
  const { profile, refreshProfile } = useAuth();
  const [form, setForm] = useState<Partial<Profile>>({
    name: '',
    role: '',
    organization: '',
    bio: '',
    resume_url: '',
    linkedin_url: '',
    website: '',
    portfolio_links: [],
    proof_points: '',
    achievements: '',
    metrics: '',
    example_emails: '',
    writing_tone: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setForm({
        name: profile.name ?? '',
        role: profile.role ?? '',
        organization: profile.organization ?? '',
        bio: profile.bio ?? '',
        resume_url: profile.resume_url ?? '',
        linkedin_url: profile.linkedin_url ?? '',
        website: profile.website ?? '',
        portfolio_links: profile.portfolio_links ?? [],
        proof_points: profile.proof_points ?? '',
        achievements: profile.achievements ?? '',
        metrics: profile.metrics ?? '',
        example_emails: profile.example_emails ?? '',
        writing_tone: profile.writing_tone ?? '',
      });
    }
  }, [profile]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.user_id) return;
    setError(null);
    setSaving(true);
    const { error: err } = await supabase
      .from('profiles')
      .update({
        name: form.name || null,
        role: form.role || null,
        organization: form.organization || null,
        bio: form.bio || null,
        resume_url: form.resume_url || null,
        linkedin_url: form.linkedin_url || null,
        website: form.website || null,
        portfolio_links: Array.isArray(form.portfolio_links) ? form.portfolio_links : null,
        proof_points: form.proof_points || null,
        achievements: form.achievements || null,
        metrics: form.metrics || null,
        example_emails: form.example_emails || null,
        writing_tone: form.writing_tone || null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', profile.user_id);
    setSaving(false);
    if (err) setError(err.message);
    else await refreshProfile();
  }

  const portfolioStr = Array.isArray(form.portfolio_links)
    ? form.portfolio_links.join('\n')
    : '';

  return (
    <div>
      <h1>Profile</h1>
      <form onSubmit={handleSubmit}>
        <section>
          <h2>Basic Info</h2>
          <div>
            <label>Name</label>
            <input
              value={form.name ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <label>Role</label>
            <input
              value={form.role ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
            />
          </div>
          <div>
            <label>Organization</label>
            <input
              value={form.organization ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))}
            />
          </div>
          <div>
            <label>Bio</label>
            <textarea
              value={form.bio ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
            />
          </div>
        </section>

        <section>
          <h2>Background</h2>
          <div>
            <label>Resume URL</label>
            <input
              value={form.resume_url ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, resume_url: e.target.value }))}
            />
          </div>
          <div>
            <label>LinkedIn</label>
            <input
              value={form.linkedin_url ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, linkedin_url: e.target.value }))}
            />
          </div>
          <div>
            <label>Website</label>
            <input
              value={form.website ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
            />
          </div>
          <div>
            <label>Portfolio links (one per line)</label>
            <textarea
              value={portfolioStr}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  portfolio_links: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                }))
              }
            />
          </div>
        </section>

        <section>
          <h2>Proof Points &amp; Achievements</h2>
          <div>
            <label>Proof points</label>
            <textarea
              value={form.proof_points ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, proof_points: e.target.value }))}
            />
          </div>
          <div>
            <label>Achievements</label>
            <textarea
              value={form.achievements ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, achievements: e.target.value }))}
            />
          </div>
          <div>
            <label>Metrics</label>
            <textarea
              value={form.metrics ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, metrics: e.target.value }))}
            />
          </div>
        </section>

        <section>
          <h2>Writing Preferences</h2>
          <div>
            <label>Tone</label>
            <input
              value={form.writing_tone ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, writing_tone: e.target.value }))}
            />
          </div>
        </section>

        <section>
          <h2>Example Emails</h2>
          <div>
            <label>Subject / Body (for voice)</label>
            <textarea
              value={form.example_emails ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, example_emails: e.target.value }))}
            />
          </div>
        </section>

        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={saving}>
          Save
        </button>
      </form>
    </div>
  );
}
