import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import {
  diffSnapshots,
  shouldSnapshot,
  snapshotFromProfile,
  type ProfileSnapshot,
  type SnapshotField,
} from '../lib/profileSnapshot';
import type { ProfileVersionSource, ContextFact } from '../types';
import { listContextFacts, addContextFact, deleteContextFact } from '../lib/personas';
import { agents } from '../lib/api';
import { ContextTab, totalScore } from './me/ContextTab';
import { History } from './me/History';
import { PersonaStudio } from './me/PersonaStudio';

type Tab = 'personalization' | 'context' | 'history';

export function Me() {
  const { profile, refreshProfile } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<ProfileSnapshot>(() => snapshotFromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('personalization');
  const [historyReloadKey, setHistoryReloadKey] = useState(0);

  // Shared, person-level context facts — the single source of truth the Context
  // tab edits and every voice reads.
  const [facts, setFacts] = useState<ContextFact[]>([]);
  const [factsLoading, setFactsLoading] = useState(true);
  const [factsKey, setFactsKey] = useState(0);

  useEffect(() => {
    setForm(snapshotFromProfile(profile));
  }, [profile]);

  useEffect(() => {
    const uid = profile?.user_id;
    if (!uid) return;
    let alive = true;
    setFactsLoading(true);
    listContextFacts(uid, null)
      .then((all) => alive && setFacts(all.filter((f) => f.scope === 'person')))
      .catch(() => alive && setFacts([]))
      .finally(() => alive && setFactsLoading(false));
    return () => {
      alive = false;
    };
  }, [profile?.user_id, factsKey]);

  const reloadFacts = useCallback(() => setFactsKey((k) => k + 1), []);

  const handleAddFact = useCallback(
    async (claim: string) => {
      const uid = profile?.user_id;
      if (!uid) return;
      try {
        await addContextFact(uid, { claim, scope: 'person', provenance: 'manual' });
        reloadFacts();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not add fact');
      }
    },
    [profile?.user_id, reloadFacts, toast]
  );

  const handleRemoveFact = useCallback(
    async (id: string) => {
      setFacts((f) => f.filter((x) => x.id !== id)); // optimistic
      try {
        await deleteContextFact(id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not remove fact');
        reloadFacts();
      }
    },
    [reloadFacts, toast]
  );

  const score = useMemo(() => totalScore(form, facts.length), [form, facts.length]);
  const percent = score.total === 0 ? 0 : Math.round((score.filled / score.total) * 100);

  async function persistProfile(snapshot: ProfileSnapshot) {
    if (!profile?.id) throw new Error('No profile');
    const { error: err } = await supabase
      .from('profiles')
      .update({
        name: snapshot.name || null,
        role: snapshot.role || null,
        organization: snapshot.organization || null,
        bio: snapshot.bio || null,
        resume_url: snapshot.resume_url || null,
        linkedin_url: snapshot.linkedin_url || null,
        website: snapshot.website || null,
        portfolio_links: snapshot.portfolio_links.length ? snapshot.portfolio_links : null,
        proof_points: snapshot.proof_points || null,
        achievements: snapshot.achievements || null,
        metrics: snapshot.metrics || null,
        example_emails: snapshot.example_emails || null,
        writing_tone: snapshot.writing_tone || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id);
    if (err) throw new Error(err.message);
  }

  /**
   * Coalesced version row.
   * Rule (see profileSnapshot.shouldSnapshot): manual saves snapshot at most once per 10 min;
   * non-manual sources (enrich/restore) always snapshot to preserve provenance.
   */
  async function maybeSnapshot(
    snapshot: ProfileSnapshot,
    source: ProfileVersionSource,
    label: string | null
  ) {
    if (!profile?.user_id) return;
    const { data: last } = await supabase
      .from('profile_versions')
      .select('snapshot, created_at')
      .eq('user_id', profile.user_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevSnap = last?.snapshot
      ? (last.snapshot as unknown as ProfileSnapshot)
      : null;
    const diffs = prevSnap ? diffSnapshots(prevSnap, snapshot) : [{ field: 'name' as SnapshotField, before: '', after: '' }];

    if (
      !shouldSnapshot({
        lastSnapshotAt: last?.created_at ?? null,
        source,
        diffs,
      })
    ) {
      return;
    }

    const { error: verErr } = await supabase.from('profile_versions').insert({
      user_id: profile.user_id,
      snapshot: snapshot as unknown as Record<string, unknown>,
      source,
      label,
    });
    if (verErr) throw new Error(verErr.message);
    setHistoryReloadKey((k) => k + 1);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.user_id) return;
    setError(null);
    setSaving(true);
    try {
      await persistProfile(form);
      await maybeSnapshot(form, 'manual', null);
      await refreshProfile();
      toast.success('Profile saved.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setError(msg);
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  /**
   * Autofill from LinkedIn: persist the current form first (so the server reads
   * the latest LinkedIn URL), run the enrichment agent, then refresh the profile
   * (role/org may have been filled) and reload the facts it added. Throws so the
   * ContextTab button can surface the error inline.
   */
  async function handleAutofill() {
    if (!profile?.user_id) return;
    await persistProfile(form);
    const { facts_added } = await agents.enrichProfile();
    await refreshProfile();
    reloadFacts();
    toast.success(
      facts_added > 0
        ? `Added ${facts_added} fact${facts_added === 1 ? '' : 's'} from your LinkedIn.`
        : 'Profile refreshed — no new facts found.'
    );
  }

  async function handleRestore(snapshot: ProfileSnapshot, fromVersionId: string) {
    if (!profile?.user_id) return;
    try {
      await persistProfile(snapshot);
      const { error: resErr } = await supabase.from('profile_versions').insert({
        user_id: profile.user_id,
        snapshot: snapshot as unknown as Record<string, unknown>,
        source: 'restore',
        label: `Restored from ${new Date().toLocaleDateString()}`,
      });
      if (resErr) throw new Error(resErr.message);
      await refreshProfile();
      setHistoryReloadKey((k) => k + 1);
      toast.success('Profile restored from this snapshot.');
      void fromVersionId;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed');
    }
  }

  return (
    <div className="me-page">
      <header className="me-header">
        <div>
          <h1 className="me-title">Me</h1>
          <p className="me-subtitle">
            Your voices and the context behind them. The agent reads this every time it drafts.
          </p>
        </div>
        <div className="me-completeness" aria-label={`Profile ${percent}% complete`}>
          <CompletenessRing percent={percent} />
          <div className="me-completeness-meta">
            <div className="me-completeness-num">{percent}%</div>
            <div className="me-completeness-label">complete</div>
          </div>
        </div>
      </header>

      <div className="me-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'personalization'}
          className={`me-tab ${tab === 'personalization' ? 'me-tab-active' : ''}`}
          onClick={() => setTab('personalization')}
        >
          Personalization
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'context'}
          className={`me-tab ${tab === 'context' ? 'me-tab-active' : ''}`}
          onClick={() => setTab('context')}
        >
          Context
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`me-tab ${tab === 'history' ? 'me-tab-active' : ''}`}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      {tab === 'personalization' ? (
        <PersonaStudio userId={profile?.user_id} />
      ) : tab === 'context' ? (
        <ContextTab
          form={form}
          setForm={setForm}
          profile={profile}
          userId={profile?.user_id ?? ''}
          saving={saving}
          error={error}
          onSubmit={handleSubmit}
          facts={facts}
          factsLoading={factsLoading}
          onAddFact={handleAddFact}
          onRemoveFact={handleRemoveFact}
          onFactsChanged={reloadFacts}
          onAutofill={handleAutofill}
        />
      ) : profile?.user_id ? (
        <History
          userId={profile.user_id}
          current={form}
          reloadKey={historyReloadKey}
          onRestore={handleRestore}
        />
      ) : null}
    </div>
  );
}

function CompletenessRing({ percent }: { percent: number }) {
  const size = 56;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (percent / 100) * c;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="me-ring"
      aria-hidden
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${c - dash}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
