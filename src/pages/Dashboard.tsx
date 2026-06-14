import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  Plus,
  Target,
  Users,
  FileText,
  ChevronRight,
  CheckCircle2,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { gmail } from '../lib/api';
import type { Mission, AgentRun } from '../types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface Stats {
  missions: number;
  drafts: number;
  contacted: number;
  replied: number;
  repliesToHandle: number;
  runsToday: number;
}

interface MissionWithStats extends Mission {
  target_count: number;
  contact_count: number;
  draft_count: number;
}

const RUN_LABEL: Record<string, string> = {
  targeting: 'Researched targets',
  contacts: 'Found contacts',
  evidence: 'Built an evidence pack',
  sequence: 'Drafted a sequence',
  reply: 'Classified a reply',
  enrich_profile: 'Enriched your profile',
  coach: 'Coached a profile field',
  parse_resume: 'Parsed a résumé',
};

// Fields that make a profile "sharp enough" for good drafts.
const PROFILE_FIELDS = ['name', 'role', 'bio', 'proof_points', 'achievements', 'metrics', 'linkedin_url', 'writing_tone'] as const;

function countByMission(rows: Array<Record<string, unknown>>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.mission_id ?? '');
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

function profileCompleteness(profile: Record<string, unknown> | null | undefined): number {
  if (!profile) return 0;
  const filled = PROFILE_FIELDS.filter((f) => {
    const v = profile[f];
    return typeof v === 'string' && v.trim().length > 0;
  }).length;
  return Math.round((filled / PROFILE_FIELDS.length) * 100);
}

export function Dashboard() {
  const { user, profile } = useAuth();
  const [missions, setMissions] = useState<MissionWithStats[]>([]);
  const [stats, setStats] = useState<Stats>({
    missions: 0,
    drafts: 0,
    contacted: 0,
    replied: 0,
    repliesToHandle: 0,
    runsToday: 0,
  });
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refetchRuns = useCallback(async () => {
    if (!user?.id) return;
    const { data } = await supabase
      .from('agent_runs')
      .select('*')
      .eq('user_id', user.id)
      .order('started_at', { ascending: false })
      .limit(8);
    setRuns((data ?? []) as AgentRun[]);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const [
        { data: msData },
        { count: draftCount },
        { count: contactedCount },
        { count: repliedCount },
        { count: repliesToHandle },
        { count: runsToday24h },
        { data: runsData },
      ] = await Promise.all([
        supabase
          .from('missions')
          .select('*')
          .eq('user_id', user!.id)
          .is('archived_at', null)
          .order('created_at', { ascending: false }),
        supabase.from('email_sequences').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'contacted'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('status', 'replied'),
        supabase.from('replies').select('id', { count: 'exact', head: true }).eq('handled', false),
        supabase.from('agent_runs').select('id', { count: 'exact', head: true }).gte('started_at', dayAgo),
        supabase.from('agent_runs').select('*').eq('user_id', user!.id).order('started_at', { ascending: false }).limit(8),
      ]);

      if (cancelled) return;

      const missionsList = (msData ?? []) as Mission[];

      // Three batched queries instead of ~4 per mission. Contacts carry a
      // denormalized mission_id, so everything groups client-side. The old
      // per-mission fan-out helped exhaust browser connections
      // (ERR_INSUFFICIENT_RESOURCES) on dashboards with several missions.
      const missionIds = missionsList.map((m) => m.id);
      const counts = { targets: new Map<string, number>(), contacts: new Map<string, number>(), drafts: new Map<string, number>() };
      if (missionIds.length > 0) {
        const [tRes, cRes, sRes] = await Promise.all([
          supabase.from('targets').select('id, mission_id').in('mission_id', missionIds),
          supabase.from('contacts').select('id, mission_id').in('mission_id', missionIds),
          supabase.from('email_sequences').select('id, mission_id').in('mission_id', missionIds),
        ]);
        counts.targets = countByMission(tRes.data ?? []);
        counts.contacts = countByMission(cRes.data ?? []);
        counts.drafts = countByMission(sRes.data ?? []);
      }
      const missionsWithStats: MissionWithStats[] = missionsList.map((m) => ({
        ...m,
        target_count: counts.targets.get(m.id) ?? 0,
        contact_count: counts.contacts.get(m.id) ?? 0,
        draft_count: counts.drafts.get(m.id) ?? 0,
      }));

      if (cancelled) return;

      setMissions(missionsWithStats);
      setStats({
        missions: missionsList.length,
        drafts: draftCount ?? 0,
        contacted: contactedCount ?? 0,
        replied: repliedCount ?? 0,
        repliesToHandle: repliesToHandle ?? 0,
        runsToday: runsToday24h ?? 0,
      });
      setRuns((runsData ?? []) as AgentRun[]);
      setLoading(false);

      // First-run only needs Gmail status (for the setup nudge).
      if (missionsList.length === 0) {
        gmail
          .status()
          .then((r) => !cancelled && setGmailConnected(r.connected))
          .catch(() => !cancelled && setGmailConnected(null));
      }
    }

    load().catch((err) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [user?.id, reloadKey]);

  // Keep the activity feed honest: while any run is in flight, re-poll until it
  // reaches a terminal state (fixes phantom "RUNNING" rows that never resolve).
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    const anyRunning = runs.some((r) => r.status === 'running');
    if (!anyRunning) return;
    pollRef.current = setTimeout(() => {
      void refetchRuns();
    }, 4000);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [runs, refetchRuns]);

  const responseRate = stats.contacted > 0 ? Math.round((stats.replied / stats.contacted) * 100) : null;
  const firstName = profile?.name ? profile.name.split(' ')[0] : null;
  const percent = profileCompleteness(profile as unknown as Record<string, unknown>);
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  // ---- First-run launchpad ----
  if (!loading && missions.length === 0) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-6 py-4 animate-fade-in">
        <div className="relative">
          {/* accent glow */}
          <div
            aria-hidden
            className="pointer-events-none absolute -top-10 left-1/4 h-48 w-2/3 -translate-x-1/2 rounded-full bg-primary/20 blur-[100px]"
          />
          <div className="panel relative overflow-hidden p-8 md:p-12">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
              {firstName ? `Welcome, ${firstName}` : 'Welcome to OutreachOS'}
            </span>
            <h1 className="mt-5 max-w-xl font-display text-4xl font-bold tracking-tight text-wash md:text-5xl">
              Let's land your first reply.
            </h1>
            <p className="mt-4 max-w-lg text-base leading-relaxed text-muted-foreground">
              Tell us who you want to reach. The agent finds the companies, the right people, the
              angle, and writes the emails. You review and send.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button asChild size="lg" className="btn-glow gap-2 border-0 font-semibold text-primary-foreground">
                <Link to="/missions/new">
                  <Plus className="h-4 w-4" /> Start your first mission
                </Link>
              </Button>
              {gmailConnected === false && (
                <Link
                  to="/settings"
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:border-border/80 hover:text-foreground"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                  Connect Gmail
                </Link>
              )}
              <Link
                to="/me"
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:border-border/80 hover:text-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                Profile <span className="text-foreground/70">{percent}%</span>
              </Link>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <LaunchStep n={1} title="Find targets" body="High-fit companies with a real reason to reach out now." />
          <LaunchStep n={2} title="Research & contacts" body="Sourced evidence + the decision-makers to email." />
          <LaunchStep n={3} title="Drafts ready" body="A personalized sequence per contact, ready to send." />
        </div>
      </div>
    );
  }

  // ---- Active dashboard ----
  const focusItems = [
    stats.drafts > 0
      ? {
          key: 'drafts',
          count: stats.drafts,
          noun: stats.drafts === 1 ? 'draft to review' : 'drafts to review',
          sub: 'Agent-written emails waiting for your eyes.',
          to: '/missions',
          cta: 'Review drafts',
        }
      : null,
    stats.repliesToHandle > 0
      ? {
          key: 'replies',
          count: stats.repliesToHandle,
          noun: stats.repliesToHandle === 1 ? 'reply to handle' : 'replies to handle',
          sub: 'Prospects wrote back. Keep the thread warm.',
          to: '/inbox',
          cta: 'Open inbox',
        }
      : null,
  ].filter(Boolean) as Array<{
    key: string; count: number; noun: string; sub: string; to: string; cta: string;
  }>;

  return (
    <div className="flex flex-col gap-7 animate-fade-in">
      <header className="flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{dateLabel}</span>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-foreground">
            {firstName ? `Welcome back, ${firstName}` : 'Dashboard'}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground/90">{stats.missions}</span>{' '}
          {stats.missions === 1 ? 'mission' : 'missions'}
          {stats.drafts > 0 && (
            <>
              {', '}
              <span className="font-medium text-foreground/90">{stats.drafts}</span>{' '}
              {stats.drafts === 1 ? 'draft' : 'drafts'} pending
            </>
          )}
          {stats.contacted > 0 && (
            <>
              {', '}
              <span className="font-medium text-foreground/90">{stats.contacted}</span> contacted
            </>
          )}
          {responseRate !== null && (
            <>
              {', '}
              <span className="font-medium text-foreground/90">{responseRate}%</span> reply rate
            </>
          )}
          .
        </p>
      </header>

      {error && (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <span>{error}</span>
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {/* Focus band - the hero region. Action cards when there's something to do,
          a clean "caught up" panel with a primary CTA otherwise. */}
      {focusItems.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-2" aria-label="Needs your attention">
          {focusItems.map((f) => (
            <Link
              key={f.key}
              to={f.to}
              className="panel group flex items-center gap-4 p-4 transition-colors hover:border-primary/45"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-xl font-bold tabular-nums text-primary ring-1 ring-inset ring-primary/20">
                {f.count}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-foreground">{f.noun}</span>
                <span className="truncate text-xs text-muted-foreground">{f.sub}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground transition-colors group-hover:text-primary">
                <span className="hidden sm:inline">{f.cta}</span>
                <ArrowUpRight className="h-4 w-4" />
              </span>
            </Link>
          ))}
        </section>
      ) : (
        !loading && (
          <section className="panel flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div className="flex items-start gap-3.5">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <CheckCircle2 className="h-5 w-5" strokeWidth={2} />
              </span>
              <div>
                <h2 className="text-base font-semibold text-foreground">You're all caught up</h2>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                  No drafts or replies waiting. Start a mission to keep the pipeline full.
                </p>
              </div>
            </div>
            <Button asChild className="btn-glow shrink-0 gap-2 border-0 font-semibold text-primary-foreground">
              <Link to="/missions/new">
                <Plus className="h-4 w-4" /> New mission
              </Link>
            </Button>
          </section>
        )
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Active missions"
            action={
              <Link to="/missions" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                All missions <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            }
          />
          {loading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-[5.5rem] w-full rounded-lg" />
              <Skeleton className="h-[5.5rem] w-full rounded-lg" />
              <Skeleton className="h-[5.5rem] w-full rounded-lg" />
            </div>
          ) : (
            <div className="panel divide-y divide-border/70 overflow-hidden">
              {missions.map((m) => {
                const pct = m.target_count > 0 ? Math.round((m.draft_count / m.target_count) * 100) : 0;
                const started = m.target_count > 0;
                // Floor a non-zero bar to 3% so it's visible, but keep 0% truly empty
                // (a green sliver next to a "0% drafted" label reads as a contradiction).
                const fillPct = pct > 0 ? Math.max(Math.min(pct, 100), 3) : 0;
                return (
                  <Link
                    key={m.id}
                    to={`/missions/${m.id}`}
                    className="group flex items-center gap-4 p-4 transition-colors hover:bg-secondary/40"
                  >
                    <span
                      aria-hidden
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-secondary/40 text-sm font-semibold uppercase text-foreground/80"
                    >
                      {m.name.trim().charAt(0) || '·'}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <strong className="truncate text-sm font-semibold text-foreground">{m.name}</strong>
                        <Badge variant="secondary" className="shrink-0 px-2 py-0 text-[10px] font-medium capitalize">
                          {m.mode}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${fillPct}%` }}
                          />
                        </div>
                        <span className="w-16 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground">
                          {started ? `${Math.min(pct, 100)}% drafted` : 'Not started'}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <MissionStat icon={Target} value={m.target_count} label="targets" />
                        <MissionStat icon={Users} value={m.contact_count} label="contacts" />
                        <MissionStat icon={FileText} value={m.draft_count} label="drafts" />
                      </div>
                    </div>
                    <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground sm:block" />
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-6">
          <section className="flex flex-col gap-3">
            <SectionHeader title="Recent activity" />
            {runs.length === 0 ? (
              <div className="panel px-3.5 py-6 text-center text-sm text-muted-foreground">
                Nothing yet. Run a mission to see activity here.
              </div>
            ) : (
              <div className="panel divide-y divide-border/60 overflow-hidden">
                {runs.map((r) => (
                  <div key={r.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                    <StatusDot status={r.status} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
                      {RUN_LABEL[r.agent_type] ?? r.agent_type}
                    </span>
                    {r.status === 'running' && (
                      <span className="shrink-0 text-[11px] font-medium text-primary">running…</span>
                    )}
                    {r.status === 'failed' && (
                      <span className="shrink-0 text-[11px] font-medium text-destructive">failed</span>
                    )}
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{timeAgo(r.started_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader title="This week" />
            <dl className="panel grid grid-cols-3 divide-x divide-border/60 overflow-hidden">
              <StatCell icon={Users} label="Contacted" value={String(stats.contacted)} />
              <StatCell icon={TrendingUp} label="Reply rate" value={responseRate === null ? '-' : `${responseRate}%`} />
              <StatCell
                icon={Zap}
                label="Runs today"
                value={`${stats.runsToday}`}
                suffix="/50"
                warn={stats.runsToday >= 40}
              />
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
        <span aria-hidden className="h-3 w-px rounded-full bg-gradient-to-b from-foreground/30 to-transparent" />
        {title}
      </h2>
      {action}
    </div>
  );
}

function MissionStat({ icon: Icon, value, label }: { icon: ComponentType<{ className?: string }>; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground/70" />
      <span className="font-medium tabular-nums text-foreground/80">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  if (status === 'running') {
    return (
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_0_hsl(153_45%_46%/0.8)]" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn('h-2 w-2 shrink-0 rounded-full', status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/40')}
    />
  );
}

function StatCell({
  icon: Icon,
  label,
  value,
  suffix,
  warn,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  suffix?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-3.5">
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium uppercase text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" /> {label}
      </span>
      <span className={cn('text-2xl font-semibold leading-none tabular-nums', warn ? 'text-warning' : 'text-foreground')}>
        {value}
        {suffix && <span className="text-sm font-normal text-muted-foreground">{suffix}</span>}
      </span>
    </div>
  );
}

function LaunchStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="panel flex gap-3 p-4 transition-transform duration-200 hover:-translate-y-0.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-sm font-semibold text-primary ring-1 ring-inset ring-primary/20">
        {n}
      </div>
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{body}</div>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
