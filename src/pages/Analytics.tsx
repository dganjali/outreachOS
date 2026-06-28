import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { analytics, type RunAnalyticsView } from '../lib/api';
import type { AgentRun } from '../types';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Human labels for every agent_runs.agent_type. Keep in sync with the union in
// shared/schemas.ts (AgentRunDoc['agentType']).
const TYPE_LABEL: Record<string, string> = {
  targeting: 'Targeting',
  contacts: 'Contacts',
  evidence: 'Evidence',
  sequence: 'Sequence',
  reply: 'Reply triage',
  enrich_profile: 'Profile enrich',
  coach: 'Coach',
  parse_resume: 'Résumé parse',
  draft: 'Draft',
  onboard_questions: 'Onboarding Q',
  refine: 'Refine',
  extract_style: 'Style extract',
  extract_context: 'Context extract',
};

function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t;
}

const WINDOWS = [7, 14, 30] as const;
type Window = (typeof WINDOWS)[number];

function fmtMs(ms: number): string {
  if (!ms) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? ` ${s}s` : ''}`;
}

function fmtPct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function durationOf(r: AgentRun): number | null {
  if (!r.completed_at) return null;
  return new Date(r.completed_at).getTime() - new Date(r.started_at).getTime();
}

// ── small presentational pieces ──────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'good' | 'bad';
}) {
  return (
    <div className="panel flex flex-col gap-2 p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div
        className={cn(
          'text-2xl font-semibold tabular-nums tracking-tight',
          tone === 'good' && 'text-emerald-500',
          tone === 'bad' && 'text-rose-500',
          tone === 'default' && 'text-foreground',
        )}
      >
        {value}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

// Stacked completed/failed daily bars. Pure SVG so we add no chart dependency.
function DailyTrend({ days }: { days: RunAnalyticsView['by_day'] }) {
  const max = Math.max(1, ...days.map((d) => d.runs));
  // Show at most ~30 bars; the window already caps this.
  const W = 100;
  const H = 40;
  const gap = days.length > 20 ? 0.18 : 0.3;
  const bw = W / days.length;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label="Runs per day">
        {days.map((d, i) => {
          const x = i * bw;
          const okH = (d.completed / max) * H;
          const failH = (d.failed / max) * H;
          const runningH = ((d.runs - d.completed - d.failed) / max) * H;
          const innerW = bw * (1 - gap);
          const ox = x + (bw * gap) / 2;
          let y = H;
          return (
            <g key={d.day}>
              {failH > 0 && (
                <rect x={ox} y={(y -= failH)} width={innerW} height={failH} className="fill-rose-500/80" />
              )}
              {runningH > 0 && (
                <rect x={ox} y={(y -= runningH)} width={innerW} height={runningH} className="fill-amber-400/70" />
              )}
              {okH > 0 && (
                <rect x={ox} y={(y -= okH)} width={innerW} height={okH} className="fill-primary/80" />
              )}
              {d.runs === 0 && <rect x={ox} y={H - 0.6} width={innerW} height={0.6} className="fill-border" />}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{days[0]?.day.slice(5)}</span>
        <div className="flex items-center gap-3">
          <Legend className="bg-primary/80" label="done" />
          <Legend className="bg-amber-400/70" label="running" />
          <Legend className="bg-rose-500/80" label="failed" />
        </div>
        <span>{days[days.length - 1]?.day.slice(5)}</span>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-[2px]', className)} />
      {label}
    </span>
  );
}

// Per-agent-type breakdown: run volume, a success-rate bar, and latency.
function TypeBreakdown({ rows }: { rows: RunAnalyticsView['by_type'] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No agent runs in this window yet.</p>;
  }
  const maxRuns = Math.max(1, ...rows.map((r) => r.runs));
  return (
    <div className="flex flex-col divide-y divide-border/60">
      {rows.map((r) => {
        const settled = r.completed + r.failed;
        return (
          <div key={r.agent_type} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[160px_1fr_auto]">
            <div className="text-sm font-medium text-foreground">{typeLabel(r.agent_type)}</div>
            <div className="order-3 col-span-2 sm:order-none sm:col-span-1">
              <div className="flex h-2 overflow-hidden rounded-full bg-secondary/60">
                {r.completed > 0 && (
                  <div className="h-full bg-primary/80" style={{ width: `${(r.completed / maxRuns) * 100}%` }} />
                )}
                {r.failed > 0 && (
                  <div className="h-full bg-rose-500/80" style={{ width: `${(r.failed / maxRuns) * 100}%` }} />
                )}
                {r.running > 0 && (
                  <div className="h-full bg-amber-400/70" style={{ width: `${(r.running / maxRuns) * 100}%` }} />
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 justify-self-end text-xs tabular-nums text-muted-foreground">
              <span title="runs">
                <span className="font-semibold text-foreground">{r.runs}</span> run{r.runs === 1 ? '' : 's'}
              </span>
              <span title="success rate" className={cn(settled === 0 && 'opacity-40')}>
                {settled === 0 ? '—' : fmtPct(r.success_rate)}
              </span>
              <span title="avg · p95 latency" className="hidden sm:inline">
                {fmtMs(r.avg_ms)} · {fmtMs(r.p95_ms)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  completed: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20',
  failed: 'bg-rose-500/10 text-rose-500 ring-rose-500/20',
  running: 'bg-amber-400/10 text-amber-500 ring-amber-400/20',
};

function RecentRuns({ runs }: { runs: AgentRun[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs recorded yet.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60">
      {runs.map((r) => {
        const isOpen = open === r.id;
        const dur = durationOf(r);
        const detail = r.error
          ? r.error
          : r.output
            ? JSON.stringify(r.output, null, 2)
            : r.input
              ? JSON.stringify(r.input, null, 2)
              : null;
        return (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : r.id)}
              className="flex w-full items-center gap-3 py-2.5 text-left"
            >
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset',
                  STATUS_STYLE[r.status] ?? 'bg-secondary text-muted-foreground ring-border',
                )}
              >
                {r.status}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{typeLabel(r.agent_type)}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {dur != null ? fmtMs(dur) : '—'}
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {relTime(r.started_at)}
              </span>
            </button>
            {isOpen && detail && (
              <pre
                className={cn(
                  'mb-2.5 max-h-56 overflow-auto rounded-md border border-border/60 bg-secondary/30 p-3 text-[11px] leading-relaxed',
                  r.error ? 'text-rose-400' : 'text-muted-foreground',
                )}
              >
                {detail}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function Analytics() {
  const [window, setWindow] = useState<Window>(30);
  const [data, setData] = useState<RunAnalyticsView | null>(null);
  const [recent, setRecent] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (win: Window) => {
      setError(null);
      try {
        const [agg, recentRows] = await Promise.all([
          analytics.runs(win),
          supabase
            .from('agent_runs')
            .select('*')
            .order('started_at', { ascending: false })
            .limit(40),
        ]);
        setData(agg.data);
        setRecent(((recentRows.data ?? []) as AgentRun[]) ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load analytics');
        setData(null);
        setRecent([]);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setRecent(null);
    void (async () => {
      await load(window);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [window, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(window);
    } finally {
      setRefreshing(false);
    }
  }, [load, window]);

  const totals = data?.totals;
  const busiest = useMemo(() => {
    if (!data || data.by_type.length === 0) return null;
    return data.by_type[0];
  }, [data]);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <Activity className="h-3.5 w-3.5" />
            Analytics
          </span>
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-foreground">
            Agent activity
          </h1>
          <p className="text-sm text-muted-foreground">
            Every AI run your account has made — volume, reliability, and speed. History spans the last 30 days.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-border bg-secondary/40 p-0.5">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindow(w)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium tabular-nums transition-colors',
                  window === w ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {w}d
              </button>
            ))}
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
        </div>
      </header>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
          {error}
        </p>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!totals ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <StatCard icon={Activity} label="Total runs" value={String(totals.runs)} sub={`last ${data!.window_days} days`} />
            <StatCard
              icon={CheckCircle2}
              label="Success rate"
              value={totals.completed + totals.failed === 0 ? '—' : fmtPct(totals.success_rate)}
              sub={`${totals.completed} ok · ${totals.failed} failed`}
              tone={totals.failed > 0 && totals.success_rate < 0.8 ? 'bad' : 'good'}
            />
            <StatCard icon={Clock} label="Avg duration" value={fmtMs(totals.avg_ms)} sub={`p95 ${fmtMs(totals.p95_ms)}`} />
            <StatCard
              icon={totals.running > 0 ? Loader2 : Gauge}
              label="In flight"
              value={String(totals.running)}
              sub={busiest ? `busiest: ${typeLabel(busiest.agent_type)}` : undefined}
            />
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Daily trend */}
        <section className="panel flex flex-col gap-3 p-5">
          <h2 className="text-sm font-semibold text-foreground">Runs per day</h2>
          {!data ? <Skeleton className="h-32 w-full" /> : <DailyTrend days={data.by_day} />}
        </section>

        {/* By type */}
        <section className="panel flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">By agent</h2>
            <span className="text-[11px] text-muted-foreground">runs · success · avg·p95</span>
          </div>
          {!data ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          ) : (
            <TypeBreakdown rows={data.by_type} />
          )}
        </section>
      </div>

      {/* Recent runs */}
      <section className="panel flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Recent runs</h2>
          {totals && totals.failed > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-rose-400">
              <AlertTriangle className="h-3 w-3" />
              {totals.failed} failed
            </span>
          )}
        </div>
        {recent === null ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <RecentRuns runs={recent} />
        )}
        <p className="text-[11px] text-muted-foreground">Tap a run to see its inputs, output, or error.</p>
      </section>
    </div>
  );
}

export default Analytics;
