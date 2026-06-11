import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { agents, type CoachField } from '../lib/api';
import {
  diffSnapshots,
  shouldSnapshot,
  snapshotFromProfile,
  type ProfileSnapshot,
  type SnapshotField,
} from '../lib/profileSnapshot';
import type {
  Profile,
  ProfileVersionSource,
  ParsedResumeFields,
  ProfileAsset,
} from '../types';
import { Workshop, totalScore } from './me/Workshop';
import { History } from './me/History';
import { CoachDrawer } from '../components/me/CoachDrawer';
import { ParseResumeModal } from '../components/me/ParseResumeModal';

type Tab = 'workshop' | 'history';

export function Me() {
  const { profile, refreshProfile } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState<ProfileSnapshot>(() => snapshotFromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('workshop');
  const [historyReloadKey, setHistoryReloadKey] = useState(0);
  const [coach, setCoach] = useState<{ open: boolean; field: CoachField | null; value: string }>({
    open: false,
    field: null,
    value: '',
  });
  const [assetReloadKey, setAssetReloadKey] = useState(0);
  const [parseModal, setParseModal] = useState<{
    open: boolean;
    asset: ProfileAsset | null;
    parsed: ParsedResumeFields | null;
  }>({ open: false, asset: null, parsed: null });
  const [parsingAssetId, setParsingAssetId] = useState<string | null>(null);

  useEffect(() => {
    setForm(snapshotFromProfile(profile));
  }, [profile]);

  const score = useMemo(() => totalScore(form), [form]);
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

  async function handleEnrich() {
    if (!form.linkedin_url) return;
    setEnriching(true);
    try {
      const r = await agents.enrichProfile();
      await refreshProfile();
      // Server already wrote enriched values into `profiles`; record a version snapshot
      // from the just-refreshed profile so History captures the agent-authored change.
      const enrichedSnap = snapshotFromProfile(
        // refreshProfile mutates AuthContext but doesn't return the new profile; we re-fetch
        // from supabase to avoid a stale-state race in the snapshot row.
        await fetchFreshProfile(profile?.user_id)
      );
      await maybeSnapshot(
        enrichedSnap,
        'enrich',
        `Enriched from ${r.source === 'apollo' ? 'a verified directory' : 'web search'}`
      );
      toast.success(
        `Enriched from ${r.source === 'apollo' ? 'a verified directory' : 'web search'}. Review and tweak.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  }

  async function handleAssetUploaded(asset: ProfileAsset) {
    setAssetReloadKey((k) => k + 1);
    if (asset.kind !== 'resume') {
      toast.success('Uploaded.');
      return;
    }
    // Trigger parse + open modal once results land.
    setParsingAssetId(asset.id);
    toast.info('Parsing resume… this may take 20-40s.');
    try {
      const r = await agents.parseResume(asset.id);
      setParseModal({ open: true, asset, parsed: r.parsed_fields });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Parse failed');
      setAssetReloadKey((k) => k + 1); // Refresh to show parse_error tag on the row.
    } finally {
      setParsingAssetId(null);
    }
  }

  async function handleAcceptParsed(
    updates: Partial<ProfileSnapshot>,
    sourceAssetId: string
  ) {
    if (!profile?.user_id) return;
    const merged: ProfileSnapshot = { ...form, ...updates };
    setForm(merged);
    try {
      await persistProfile(merged);
      const { error: impErr } = await supabase.from('profile_versions').insert({
        user_id: profile.user_id,
        snapshot: merged as unknown as Record<string, unknown>,
        source: 'import',
        label: `Imported from resume`,
      });
      if (impErr) throw new Error(impErr.message);
      await refreshProfile();
      setHistoryReloadKey((k) => k + 1);
      setParseModal({ open: false, asset: null, parsed: null });
      toast.success('Profile updated from resume.');
      void sourceAssetId;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    }
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
            The agent reads this every time it drafts an email. Sharper inputs, sharper outreach.
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
          aria-selected={tab === 'workshop'}
          className={`me-tab ${tab === 'workshop' ? 'me-tab-active' : ''}`}
          onClick={() => setTab('workshop')}
        >
          Workshop
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

      {tab === 'workshop' ? (
        <Workshop
          form={form}
          setForm={setForm}
          profile={profile}
          saving={saving}
          enriching={enriching}
          error={error}
          onSubmit={handleSubmit}
          onEnrich={handleEnrich}
          onCoach={(field, value) => setCoach({ open: true, field, value })}
          assetReloadKey={assetReloadKey}
          onAssetUploaded={handleAssetUploaded}
          onAssetError={(msg) => toast.error(msg)}
        />
      ) : profile?.user_id ? (
        <History
          userId={profile.user_id}
          current={form}
          reloadKey={historyReloadKey}
          onRestore={handleRestore}
        />
      ) : null}

      <CoachDrawer
        open={coach.open}
        field={coach.field}
        currentValue={coach.value}
        onClose={() => setCoach((c) => ({ ...c, open: false }))}
        onApply={(field, value) => {
          setForm((f) => ({ ...f, [field]: value }));
          setCoach((c) => ({ ...c, open: false }));
          toast.success('Suggestion applied. Save to keep it.');
        }}
      />

      <ParseResumeModal
        open={parseModal.open}
        asset={parseModal.asset}
        parsed={parseModal.parsed}
        current={form}
        onClose={() => setParseModal({ open: false, asset: null, parsed: null })}
        onAccept={handleAcceptParsed}
      />

      {parsingAssetId && (
        <div className="parse-toast">
          <span className="parse-toast-spinner" aria-hidden />
          Parsing resume…
        </div>
      )}
    </div>
  );
}

async function fetchFreshProfile(userId: string | undefined): Promise<Profile | null> {
  if (!userId) return null;
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  return (data as Profile | null) ?? null;
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
