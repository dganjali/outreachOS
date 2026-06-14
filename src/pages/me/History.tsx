import { useEffect, useState } from 'react';
import { supabase } from '../../supabaseClient';
import { useConfirm } from '../../context/ConfirmContext';
import {
  diffSnapshots,
  fieldLabel,
  normalizeSnapshot,
  SNAPSHOT_FIELDS,
  type ProfileSnapshot,
  type SnapshotDiff,
  type SnapshotField,
} from '../../lib/profileSnapshot';

function asSnapshotField(s: string): SnapshotField | null {
  return (SNAPSHOT_FIELDS as readonly string[]).includes(s) ? (s as SnapshotField) : null;
}
import type { ProfileVersion, ProfileVersionSource } from '../../types';

interface VersionOutcome {
  sent_count: number;
  reply_count: number;
  reply_rate: number;
  top_field: string | null;
}

interface HistoryProps {
  userId: string;
  current: ProfileSnapshot;
  reloadKey: number;
  onRestore: (snapshot: ProfileSnapshot, fromVersionId: string) => Promise<void>;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const SOURCE_LABEL: Record<ProfileVersionSource, string> = {
  manual: 'Manual save',
  enrich: 'Enriched',
  coach: 'Coach',
  import: 'Imported',
  restore: 'Restored',
};

function truncate(s: string, n = 90): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + '…';
}

function renderValue(v: string | string[]): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return '(empty)';
    return v.join(', ');
  }
  if (v === '') return '(empty)';
  return v;
}

export function History({ userId, current, reloadKey, onRestore }: HistoryProps) {
  const confirm = useConfirm();
  const [versions, setVersions] = useState<ProfileVersion[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, VersionOutcome>>({});
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [restoringId, setRestoringId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    (async () => {
      const { data, error: err } = await supabase
        .from('profile_versions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setVersions([]);
        return;
      }
      setVersions((data ?? []) as ProfileVersion[]);

      // Fetch outcome rollup. View is RLS-scoped to the same user.
      const { data: outcomeRows } = await supabase
        .from('profile_version_outcomes')
        .select('profile_version_id, sent_count, reply_count, reply_rate')
        .eq('user_id', userId);

      // Per-version top-cited field: most common profile_refs[].field across sent_messages.
      // Cheap to do client-side: pull recent sent_messages and tally.
      const { data: sent } = await supabase
        .from('sent_messages')
        .select('profile_version_id, profile_refs')
        .eq('user_id', userId)
        .not('profile_version_id', 'is', null)
        .limit(500);

      if (cancelled) return;

      const topByVersion: Record<string, string> = {};
      const tallies: Record<string, Record<string, number>> = {};
      for (const row of (sent ?? []) as Array<{
        profile_version_id: string | null;
        profile_refs: Array<{ field?: string }> | null;
      }>) {
        if (!row.profile_version_id || !Array.isArray(row.profile_refs)) continue;
        const t = (tallies[row.profile_version_id] ??= {});
        for (const ref of row.profile_refs) {
          if (typeof ref?.field === 'string') t[ref.field] = (t[ref.field] ?? 0) + 1;
        }
      }
      for (const [vid, counts] of Object.entries(tallies)) {
        let best: string | null = null;
        let bestN = 0;
        for (const [field, n] of Object.entries(counts)) {
          if (n > bestN) {
            best = field;
            bestN = n;
          }
        }
        if (best) topByVersion[vid] = best;
      }

      const map: Record<string, VersionOutcome> = {};
      for (const o of (outcomeRows ?? []) as Array<{
        profile_version_id: string;
        sent_count: number;
        reply_count: number;
        reply_rate: number | string;
      }>) {
        map[o.profile_version_id] = {
          sent_count: Number(o.sent_count) || 0,
          reply_count: Number(o.reply_count) || 0,
          reply_rate: Number(o.reply_rate) || 0,
          top_field: topByVersion[o.profile_version_id] ?? null,
        };
      }
      setOutcomes(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

  if (versions === null) {
    return <p className="me-history-empty">Loading history…</p>;
  }

  if (error) {
    return (
      <p role="alert" className="banner-error">
        {error}
      </p>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="me-history-empty">
        <h3>No history yet</h3>
        <p>
          Save your profile from the Context tab. Each save creates a snapshot so you can compare
          versions and roll back.
        </p>
      </div>
    );
  }

  return (
    <ol className="me-history">
      {versions.map((v, i) => {
        const snap = normalizeSnapshot(v.snapshot);
        const prev = versions[i + 1];
        const prevSnap = prev ? normalizeSnapshot(prev.snapshot) : null;
        const diffs: SnapshotDiff[] = prevSnap ? diffSnapshots(prevSnap, snap) : [];
        const isFirst = i === versions.length - 1;
        const isLatest = i === 0;
        const currentDiffs = diffSnapshots(snap, current);
        const matchesCurrent = currentDiffs.length === 0;
        const isOpen = !!expanded[v.id];

        return (
          <li key={v.id} className="me-history-item">
            <div className="me-history-rail" aria-hidden>
              <span className="me-history-dot" />
              {i < versions.length - 1 && <span className="me-history-line" />}
            </div>
            <article className="me-history-card">
              <header className="me-history-card-head">
                <div className="me-history-card-meta">
                  <span className={`me-history-source me-history-source-${v.source}`}>
                    {SOURCE_LABEL[v.source]}
                  </span>
                  {isLatest && matchesCurrent && (
                    <span className="me-history-badge">Current</span>
                  )}
                  {v.label && <span className="me-history-label">{v.label}</span>}
                </div>
                <div className="me-history-card-time">
                  <span title={new Date(v.created_at).toLocaleString()}>
                    {relTime(v.created_at)}
                  </span>
                </div>
              </header>

              <div className="me-history-summary">
                {isFirst ? (
                  <span className="me-history-muted">Initial snapshot.</span>
                ) : diffs.length === 0 ? (
                  <span className="me-history-muted">No field changes vs previous.</span>
                ) : (
                  <span>
                    Changed{' '}
                    <strong>
                      {diffs.length} field{diffs.length === 1 ? '' : 's'}
                    </strong>
                    : {diffs.map((d) => fieldLabel(d.field)).join(', ')}
                  </span>
                )}
              </div>

              {diffs.length > 0 && (
                <button
                  type="button"
                  className="me-history-expand"
                  onClick={() =>
                    setExpanded((e) => ({ ...e, [v.id]: !e[v.id] }))
                  }
                  aria-expanded={isOpen}
                >
                  {isOpen ? 'Hide diff' : 'Show diff'}
                </button>
              )}

              {isOpen && diffs.length > 0 && (
                <div className="me-history-diff">
                  {diffs.map((d) => (
                    <div key={d.field} className="me-history-diff-row">
                      <div className="me-history-diff-field">{fieldLabel(d.field)}</div>
                      <div className="me-history-diff-cols">
                        <div className="me-history-diff-before">
                          <span className="me-history-diff-tag">before</span>
                          <span>{truncate(renderValue(d.before))}</span>
                        </div>
                        <div className="me-history-diff-after">
                          <span className="me-history-diff-tag">after</span>
                          <span>{truncate(renderValue(d.after))}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {(() => {
                const o = outcomes[v.id];
                if (!o || o.sent_count === 0) return null;
                return (
                  <div className="me-history-outcomes">
                    <span className="me-history-outcome-stat">
                      <strong>{o.sent_count}</strong> sent
                    </span>
                    <span className="me-history-outcome-sep">·</span>
                    <span className="me-history-outcome-stat">
                      <strong>{o.reply_count}</strong>{' '}
                      {o.reply_count === 1 ? 'reply' : 'replies'}{' '}
                      <span className="me-history-outcome-rate">({o.reply_rate}%)</span>
                    </span>
                    {o.top_field &&
                      (() => {
                        const f = asSnapshotField(o.top_field);
                        if (!f) return null;
                        return (
                          <>
                            <span className="me-history-outcome-sep">·</span>
                            <span className="me-history-outcome-stat">
                              most-cited <strong>{fieldLabel(f)}</strong>
                            </span>
                          </>
                        );
                      })()}
                  </div>
                );
              })()}

              <footer className="me-history-card-foot">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={matchesCurrent || restoringId === v.id}
                  title={matchesCurrent ? 'This snapshot matches your current profile' : 'Roll back to this snapshot'}
                  onClick={async () => {
                    if (matchesCurrent) return;
                    if (
                      !(await confirm({
                        title: 'Restore this snapshot?',
                        description: 'Your current profile will be overwritten (a new version row will be created).',
                        confirmText: 'Restore',
                      }))
                    )
                      return;
                    setRestoringId(v.id);
                    try {
                      await onRestore(snap, v.id);
                    } finally {
                      setRestoringId(null);
                    }
                  }}
                >
                  {restoringId === v.id ? 'Restoring…' : matchesCurrent ? 'Matches current' : 'Restore'}
                </button>
              </footer>
            </article>
          </li>
        );
      })}
    </ol>
  );
}
