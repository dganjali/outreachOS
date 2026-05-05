import { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { agents } from '../lib/api';
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
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichMessage, setEnrichMessage] = useState<string | null>(null);

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
    else {
      setSavedAt(Date.now());
      await refreshProfile();
    }
  }

  const portfolioStr = Array.isArray(form.portfolio_links)
    ? form.portfolio_links.join('\n')
    : '';

  async function handleEnrich() {
    setEnrichMessage(null);
    setEnriching(true);
    try {
      const r = await agents.enrichProfile();
      await refreshProfile();
      setEnrichMessage(
        `Enriched from ${r.source === 'apollo' ? 'Apollo' : 'web search'}. Review and tweak below.`
      );
    } catch (err) {
      setEnrichMessage(err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  }

  return (
    <div className="profile-page">
      <header className="dashboard-header">
        <div>
          <h1 style={{ margin: 0 }}>Profile</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Used by the agent to personalize every email it drafts.
          </p>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="profile-form">
        <section className="profile-section">
          <h2>Basic info</h2>
          <div className="profile-grid">
            <div className="field">
              <label>Name</label>
              <input
                type="text"
                value={form.name ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Role / title</label>
              <input
                type="text"
                value={form.role ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Organization</label>
              <input
                type="text"
                value={form.organization ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))}
              />
            </div>
          </div>
          <div className="field">
            <label>Bio</label>
            <textarea
              rows={3}
              value={form.bio ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
            />
          </div>
        </section>

        <section className="profile-section">
          <h2>Links</h2>
          <div className="profile-grid">
            <div className="field">
              <label>Resume URL</label>
              <input
                type="url"
                value={form.resume_url ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, resume_url: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>LinkedIn</label>
              <input
                type="url"
                value={form.linkedin_url ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, linkedin_url: e.target.value }))}
              />
            </div>
            <div className="field">
              <label>Website</label>
              <input
                type="url"
                value={form.website ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))}
              />
            </div>
          </div>
          <div className="profile-actions" style={{ marginTop: '0.75rem' }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleEnrich}
              disabled={enriching || !form.linkedin_url}
              title={!form.linkedin_url ? 'Add a LinkedIn URL first' : 'Auto-fill bio, proof points, and tone from your LinkedIn'}
            >
              {enriching ? 'Enriching…' : profile?.linkedin_enriched_at ? 'Re-enrich from LinkedIn' : 'Enrich from LinkedIn'}
            </button>
            {profile?.linkedin_enriched_at && (
              <span className="profile-saved">
                Last enriched {new Date(profile.linkedin_enriched_at).toLocaleDateString()}
              </span>
            )}
          </div>
          {enrichMessage && <p className="section-hint" style={{ marginTop: '0.5rem' }}>{enrichMessage}</p>}
          <div className="field">
            <label>Portfolio links (one per line)</label>
            <textarea
              rows={3}
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

        <section className="profile-section">
          <h2>Sender credibility</h2>
          <p className="section-hint">Specifics here become anchor points the agent can reference in your outreach.</p>
          <div className="field">
            <label>Proof points</label>
            <textarea
              rows={3}
              placeholder="e.g. Hack the North 2025 (1.4k attendees), backed by Vercel/Notion"
              value={form.proof_points ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, proof_points: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Achievements</label>
            <textarea
              rows={3}
              value={form.achievements ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, achievements: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Metrics</label>
            <textarea
              rows={3}
              placeholder="e.g. 2.3k weekly DAUs, 41% MoM growth, $120k ARR"
              value={form.metrics ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, metrics: e.target.value }))}
            />
          </div>
        </section>

        <section className="profile-section">
          <h2>Voice & style</h2>
          <div className="field">
            <label>Preferred tone</label>
            <input
              type="text"
              placeholder="e.g. direct, warm, technical, no jargon"
              value={form.writing_tone ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, writing_tone: e.target.value }))}
            />
          </div>
          <div className="field">
            <label>Example emails (style reference)</label>
            <textarea
              rows={6}
              value={form.example_emails ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, example_emails: e.target.value }))}
            />
          </div>
        </section>

        {error && <p role="alert" className="banner-error">{error}</p>}

        <div className="profile-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </button>
          {savedAt && <span className="profile-saved">Saved.</span>}
        </div>
      </form>
    </div>
  );
}
