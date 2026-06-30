import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, FileText, Radar, RefreshCw, Send, MessageSquare } from 'lucide-react';
import { supabase } from '../supabaseClient';
import type { Mission } from '../types';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Outreach outcomes, not agent internals: what your missions actually produced.
// Sourced (people/companies the agent found) -> Drafts -> Sent -> Replied.

// Rows come back from the data shim in snake_case (same shape the Dashboard reads).
interface Row {
  mission_id?: string;
  status?: string;
  contact_id?: string;
  sent_at?: string | null;
}

interface MissionOutcome {
  id: string;
  name: string;
  isPeople: boolean;
  sourced: number;
  drafts: number;
  sent: number;
  replied: number;
}

interface Totals {
  sourced: number;
  drafts: number;
  sent: number;
  replied: number;
}

// Selectable trend windows. 0 = "All", resolved to the span since the first send.
const RANGE_OPTIONS = [
  { id: 7, label: '7d' },
  { id: 30, label: '30d' },
  { id: 90, label: '90d' },
  { id: 0, label: 'All' },
] as const;
type RangeId = (typeof RANGE_OPTIONS)[number]['id'];
const DEFAULT_RANGE: RangeId = 30;
// Hard cap so "All" on a very old account stays a readable bar chart, not 1000 slivers.
const MAX_TREND_DAYS = 365;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

type SortKey = 'name' | 'sourced' | 'drafts' | 'sent' | 'replied';

// ── small presentational pieces ──────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="panel flex flex-col gap-2 p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-2xl font-semibold tabular-nums leading-none tracking-tight text-foreground">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// Sent-per-day over the trend window. A calm read on momentum, not a dashboard.
function SentTrend({ counts }: { counts: { day: string; sent: number }[] }) {
  const max = Math.max(1, ...counts.map((d) => d.sent));
  const W = 100;
  const H = 40;
  const bw = W / counts.length;
  const gap = counts.length > 20 ? 0.18 : 0.3;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Emails sent per day">
        {counts.map((d, i) => {
          const x = i * bw;
          const h = (d.sent / max) * H;
          const innerW = bw * (1 - gap);
          const ox = x + (bw * gap) / 2;
          return d.sent > 0 ? (
            <rect key={d.day} x={ox} y={H - h} width={innerW} height={h} className="fill-primary/80" />
          ) : (
            <rect key={d.day} x={ox} y={H - 0.6} width={innerW} height={0.6} className="fill-border" />
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{counts[0]?.day.slice(5)}</span>
        <span>{counts[counts.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

function MissionBreakdown({ rows }: { rows: MissionOutcome[] }) {
  // Sort by any column. Click a header to sort; click again to flip direction.
  // Name sorts A→Z by default; numeric columns sort high→low first (the more
  // useful read on outcomes). Default is "most sourced" so the busiest leads.
  const [sortKey, setSortKey] = useState<SortKey>('sourced');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name);
      return dir * (a[sortKey] - b[sortKey]);
    });
  }, [rows, sortKey, sortDir]);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No missions yet. Create one to start sourcing.</p>;
  }

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');
  const numCols: Array<{ key: SortKey; label: string }> = [
    { key: 'sourced', label: 'Sourced' },
    { key: 'drafts', label: 'Drafts' },
    { key: 'sent', label: 'Sent' },
    { key: 'replied', label: 'Replied' },
  ];

  return (
    <div className="flex flex-col divide-y divide-border/60">
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 py-2 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground sm:grid-cols-[1fr_repeat(4,56px)]">
        <button
          type="button"
          onClick={() => toggleSort('name')}
          className="text-left transition-colors hover:text-foreground"
          aria-label="Sort by mission name"
        >
          Mission{arrow('name')}
        </button>
        {numCols.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => toggleSort(c.key)}
            className="hidden text-right transition-colors hover:text-foreground sm:block"
            aria-label={`Sort by ${c.label.toLowerCase()}`}
          >
            {c.label}{arrow(c.key)}
          </button>
        ))}
      </div>
      {sorted.map((r) => (
        <div
          key={r.id}
          className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 py-3 sm:grid-cols-[1fr_repeat(4,56px)]"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">{r.name}</div>
            <div className="text-[11px] text-muted-foreground sm:hidden">
              {r.sourced} sourced · {r.drafts} drafts · {r.sent} sent · {r.replied} replied
            </div>
          </div>
          <span className="hidden text-right text-sm tabular-nums text-foreground sm:block">{r.sourced}</span>
          <span className="hidden text-right text-sm tabular-nums text-foreground sm:block">{r.drafts}</span>
          <span className="hidden text-right text-sm tabular-nums text-foreground sm:block">{r.sent}</span>
          <span className="hidden text-right text-sm tabular-nums text-foreground sm:block">{r.replied}</span>
        </div>
      ))}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function Analytics() {
  const [missions, setMissions] = useState<MissionOutcome[] | null>(null);
  // Raw "sent" rows kept in state so the trend window can change without refetching.
  const [sentRows, setSentRows] = useState<Row[] | null>(null);
  const [rangeDays, setRangeDays] = useState<RangeId>(DEFAULT_RANGE);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [missionsRes, targetsRes, seqRes, sentRes, contactsRes] = await Promise.all([
        supabase.from('missions').select('id, name, find_mode').order('created_at', { ascending: false }),
        supabase.from('targets').select('mission_id, status'),
        supabase.from('email_sequences').select('mission_id, contact_id'),
        supabase.from('sent_messages').select('mission_id, status, sent_at'),
        supabase.from('contacts').select('mission_id, status'),
      ]);

      const missionList = (missionsRes.data ?? []) as Array<Pick<Mission, 'id' | 'name' | 'find_mode'>>;
      const targets = (targetsRes.data ?? []) as Row[];
      const seqs = (seqRes.data ?? []) as Row[];
      const sent = (sentRes.data ?? []) as Row[];
      const contacts = (contactsRes.data ?? []) as Row[];

      // Sourced = targets the user can still see (a dropped/rejected target is not
      // a delivered outcome). Drafts = one per contact with a sequence. Sent =
      // sent_messages that actually went out. Replied = contacts marked replied.
      const sourcedBy = countBy(targets.filter((t) => t.status !== 'rejected'));
      const draftsBy = countDistinctBy(seqs);
      const sentBy = countBy(sent.filter((s) => s.status === 'sent'));
      const repliedBy = countBy(contacts.filter((c) => c.status === 'replied'));

      const outcomes: MissionOutcome[] = missionList.map((m) => ({
        id: m.id,
        name: m.name,
        isPeople: m.find_mode === 'people',
        sourced: sourcedBy.get(m.id) ?? 0,
        drafts: draftsBy.get(m.id) ?? 0,
        sent: sentBy.get(m.id) ?? 0,
        replied: repliedBy.get(m.id) ?? 0,
      }));

      setMissions(outcomes);
      setSentRows(sent.filter((s) => s.status === 'sent'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
      setMissions([]);
      setSentRows([]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMissions(null);
    setSentRows(null);
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const totals = useMemo<Totals | null>(() => {
    if (!missions) return null;
    return missions.reduce<Totals>(
      (acc, m) => ({
        sourced: acc.sourced + m.sourced,
        drafts: acc.drafts + m.drafts,
        sent: acc.sent + m.sent,
        replied: acc.replied + m.replied,
      }),
      { sourced: 0, drafts: 0, sent: 0, replied: 0 },
    );
  }, [missions]);

  // Resolve the selected window to a concrete day count, then bucket the sent
  // rows. "All" spans from the first send to today (capped), defaulting to the
  // 30-day view until anything has been sent.
  const trend = useMemo<{ day: string; sent: number }[] | null>(() => {
    if (!sentRows) return null;
    let days: number = rangeDays;
    if (rangeDays === 0) {
      let earliest = Infinity;
      for (const s of sentRows) {
        const t = s.sent_at ? new Date(s.sent_at).getTime() : NaN;
        if (!Number.isNaN(t)) earliest = Math.min(earliest, t);
      }
      days = Number.isFinite(earliest)
        ? Math.min(MAX_TREND_DAYS, Math.max(7, Math.ceil((Date.now() - earliest) / 86_400_000) + 1))
        : 30;
    }
    return buildTrend(sentRows, days);
  }, [sentRows, rangeDays]);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            Analytics
          </span>
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-foreground">Outreach so far</h1>
          <p className="text-sm text-muted-foreground">
            What your missions have produced: people and companies sourced, drafts written, emails sent, and replies.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border bg-secondary/40 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
        </button>
      </header>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
          {error}
        </p>
      )}

      {/* Headline outcomes */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!totals ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <StatCard icon={Radar} label="Sourced" value={String(totals.sourced)} sub="people and companies found" />
            <StatCard icon={FileText} label="Drafts" value={String(totals.drafts)} sub="personalized emails written" />
            <StatCard icon={Send} label="Sent" value={String(totals.sent)} sub="emails delivered" />
            <StatCard icon={MessageSquare} label="Replied" value={String(totals.replied)} sub="contacts marked replied" />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        {/* Sent over time */}
        <section className="panel flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-foreground">
              {rangeDays === 0 ? 'Sent, all time' : `Sent, last ${rangeDays} days`}
            </h2>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-0.5">
              {RANGE_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setRangeDays(o.id)}
                  aria-pressed={rangeDays === o.id}
                  className={cn(
                    'rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors',
                    rangeDays === o.id
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          {!trend ? <Skeleton className="h-32 w-full" /> : <SentTrend counts={trend} />}
        </section>

        {/* By mission */}
        <section className="panel flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">By mission</h2>
          {!missions ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <MissionBreakdown rows={missions} />
          )}
        </section>
      </div>
    </div>
  );
}

// ── grouping helpers (mirrors the Dashboard's per-mission count pattern) ──────

function countBy(rows: Row[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.mission_id ?? '');
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// Drafts are one-per-contact, so count distinct contacts (matches the mission page).
function countDistinctBy(rows: Row[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const m = String(r.mission_id ?? '');
    if (!seen.has(m)) seen.set(m, new Set());
    seen.get(m)!.add(String(r.contact_id ?? ''));
  }
  const map = new Map<string, number>();
  for (const [m, set] of seen) map.set(m, set.size);
  return map;
}

function buildTrend(sent: Row[], days: number): { day: string; sent: number }[] {
  const byDay = new Map<string, number>();
  for (const s of sent) {
    const iso = s.sent_at;
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const k = dayKey(d);
    byDay.set(k, (byDay.get(k) ?? 0) + 1);
  }
  const out: { day: string; sent: number }[] = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const k = dayKey(d);
    out.push({ day: k, sent: byDay.get(k) ?? 0 });
  }
  return out;
}

export default Analytics;
