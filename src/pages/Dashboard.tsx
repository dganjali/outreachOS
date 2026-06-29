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
  Zap,
  Sunrise,
  Sun,
  Moon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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

// A "no contacts found" run isn't a crash - the search ran fine, it just couldn't
// confirm a reachable person for that company. Plain-English the stage it stopped
// at so the row reads as an outcome, not an error.
const DROP_STAGE_LABEL: Record<string, string> = {
  no_domain: "Couldn't find the company's email domain to search.",
  no_candidates: 'No matching people surfaced in the search.',
  no_candidates_kept: 'Found people, but none fit the target role.',
  no_email_resolved: 'Found the right people, but no reachable address.',
};

type RunTone = 'running' | 'failed' | 'empty' | 'done';

// Decide how an agent run reads in the feed. The key move: a `no_contacts_found`
// failure is surfaced as a calm "no contacts" outcome (amber), not an alarming
// red "failed" - it's the expected result when a company has no reachable person.
function describeRun(r: AgentRun): { label: string; tone: RunTone; tag?: string; title?: string } {
  const base = RUN_LABEL[r.agent_type] ?? r.agent_type;
  if (r.status === 'running') return { label: base, tone: 'running' };
  if (r.status === 'failed') {
    if (r.error === 'no_contacts_found') {
      const stage = typeof r.output?.drop_stage === 'string' ? r.output.drop_stage : undefined;
      return {
        label: 'No contacts found',
        tone: 'empty',
        tag: 'no contacts',
        title: (stage && DROP_STAGE_LABEL[stage]) || 'The search found no reachable contact for this company.',
      };
    }
    return { label: base, tone: 'failed', tag: 'failed', title: r.error ?? undefined };
  }
  return { label: base, tone: 'done' };
}

// Fields that make a profile "sharp enough" for good drafts.
const PROFILE_FIELDS = ['name', 'role', 'bio', 'proof_points', 'achievements', 'metrics', 'linkedin_url', 'writing_tone'] as const;

// The agent pipeline, shown on the first-run launchpad so a new user sees what
// a mission actually does before starting one.
const FLOW = [
  { title: 'Find targets', body: 'High-fit companies with a real reason to reach out now.' },
  { title: 'Find people', body: 'The decision-makers to email, with verified addresses.' },
  { title: 'Research & draft', body: 'Sourced evidence turned into a personalized sequence.' },
  { title: 'Review & send', body: 'You approve; send from your own Gmail in a click.' },
] as const;

function countByMission(rows: Array<Record<string, unknown>>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.mission_id ?? '');
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

// Distinct-value count per mission. Drafts are one-per-contact, so the card's
// "drafts" stat counts distinct contacts (not raw email_sequences rows) to stay
// in agreement with the missions list and the mission header.
function countDistinctByMission(
  rows: Array<Record<string, unknown>>,
  distinctKey: string
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const m = String(r.mission_id ?? '');
    if (!seen.has(m)) seen.set(m, new Set());
    seen.get(m)!.add(String(r[distinctKey] ?? ''));
  }
  const map = new Map<string, number>();
  for (const [m, set] of seen) map.set(m, set.size);
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

// ---- Live / time-aware helpers ----

// A clock that re-renders the dashboard on an interval so relative timestamps,
// the header time, and the time-of-day greeting stay honest without a reload.
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const update = () => setReduce(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduce;
}

// Eased count-up. Animates 0 → target whenever target changes (e.g. when the
// dashboard data finishes loading). No-ops to the final value when disabled.
function useCountUp(target: number, enabled: boolean, durationMs = 850): number {
  const [val, setVal] = useState(enabled ? 0 : target);
  useEffect(() => {
    if (!enabled) {
      setVal(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min((t - start) / durationMs, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setVal(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, durationMs]);
  return val;
}

function Counter({ value, animate, unit }: { value: number; animate: boolean; unit?: string }) {
  const n = useCountUp(value, animate);
  return (
    <>
      {n}
      {unit}
    </>
  );
}

// Time-of-day greeting: label + matching icon + an HSL accent that tints the
// header glow and the icon. Shifts as the day passes (re-derived from useNow).
function greetingFor(d: Date): { label: string; Icon: LucideIcon; accent: string } {
  const h = d.getHours();
  if (h < 12) return { label: 'Good morning', Icon: Sunrise, accent: '35 92% 60%' };
  if (h < 18) return { label: 'Good afternoon', Icon: Sun, accent: '45 90% 58%' };
  return { label: 'Good evening', Icon: Moon, accent: '232 58% 70%' };
}

export function Dashboard() {
  const { user, profile } = useAuth();
  const [missions, setMissions] = useState<MissionWithStats[]>([]);
  const [stats, setStats] = useState<Stats>({
    missions: 0,
    drafts: 0,
    contacted: 0,
    repliesToHandle: 0,
    runsToday: 0,
  });
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [gmailConnected, setGmailConnected] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [barsIn, setBarsIn] = useState(false);
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
          supabase.from('email_sequences').select('mission_id, contact_id').in('mission_id', missionIds),
        ]);
        counts.targets = countByMission(tRes.data ?? []);
        counts.contacts = countByMission(cRes.data ?? []);
        counts.drafts = countDistinctByMission(sRes.data ?? [], 'contact_id');
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

  // Once data has loaded, flip the flag that animates the mission progress bars
  // from 0 → their real fill (a quick rAF so the transition has a frame to run).
  useEffect(() => {
    if (loading) {
      setBarsIn(false);
      return;
    }
    const id = requestAnimationFrame(() => setBarsIn(true));
    return () => cancelAnimationFrame(id);
  }, [loading]);

  const now = useNow();
  const reduceMotion = usePrefersReducedMotion();
  // Gate count-ups on "loaded + motion allowed" so numbers animate in once the
  // real data arrives, and snap straight to final for reduced-motion users.
  const animateNums = !reduceMotion && !loading;
  const greet = greetingFor(now);

  const firstName = profile?.name ? profile.name.split(' ')[0] : null;
  const percent = profileCompleteness(profile as unknown as Record<string, unknown>);
  const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const timeLabel = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  // ---- First-run launchpad ----
  if (!loading && missions.length === 0) {
    const setupItems = [
      {
        done: percent >= 80,
        label: 'Sharpen your profile',
        desc: 'The agent writes in your voice — give it more to work with.',
        to: '/me',
        cta: percent >= 80 ? 'Looking good' : `${percent}% done`,
      },
      {
        done: gmailConnected === true,
        label: 'Connect Gmail',
        desc: 'Send approved drafts straight from your own inbox.',
        to: '/settings',
        cta: gmailConnected === true ? 'Connected' : 'Connect',
      },
      {
        done: false,
        label: 'Launch your first mission',
        desc: 'Tell us who to reach — the agents take it from there.',
        to: '/missions/new',
        cta: 'Start',
      },
    ];
    const doneCount = setupItems.filter((s) => s.done).length;

    return (
      <div className="flex flex-col gap-7 animate-fade-in">
        <header className="relative flex flex-col gap-1.5">
          {!reduceMotion && (
            <div
              aria-hidden
              className="pointer-events-none absolute -left-12 -top-16 -z-10 h-44 w-2/3 rounded-full opacity-40 blur-[90px]"
              style={{
                background: `radial-gradient(closest-side, hsl(${greet.accent} / 0.4), transparent)`,
                animation: 'mh-breathe 9s ease-in-out infinite',
                transition: 'background 1.5s ease',
              }}
            />
          )}
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            <span>{dateLabel}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="relative inline-flex h-1.5 w-1.5 items-center" aria-hidden title="Live">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span className="tabular-nums text-foreground/70">{timeLabel}</span>
          </span>
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-foreground">
            {firstName ? `${greet.label}, ${firstName}` : greet.label}
          </h1>
          <p className="text-sm text-muted-foreground">
            Your pipeline is empty — let's get the first emails moving.
          </p>
        </header>

        {/* Hero */}
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-10 left-1/3 h-48 w-2/3 -translate-x-1/2 rounded-full bg-primary/20 blur-[100px]"
          />
          <div className="panel relative overflow-hidden p-8 md:p-11">
            <div className="relative max-w-xl">
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                {firstName ? `${greet.label}, ${firstName}` : 'Welcome to OutreachOS'}
              </span>
              <h2 className="mt-5 font-display text-4xl font-bold tracking-tight text-wash md:text-5xl">
                Let's land your first reply.
              </h2>
              <p className="mt-4 max-w-lg text-base leading-relaxed text-muted-foreground">
                Tell us who you want to reach. The agent finds the companies, the right people, the
                angle, and writes the emails. You review and send.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button asChild size="lg" className="btn-glow gap-2 border-0 font-semibold text-primary-foreground">
                  <Link to="/missions/new">Start your first mission</Link>
                </Button>
                <Link
                  to="/me"
                  className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary/40 px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:border-border/80 hover:text-foreground"
                >
                  Profile <span className="text-foreground/70">{percent}%</span>
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* How it works + Get set up */}
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <section className="flex flex-col gap-3">
            <SectionHeader title="How it works" />
            <div className="panel p-5 sm:p-6">
              <div className="grid gap-5 sm:grid-cols-4 sm:gap-3">
                {FLOW.map((step, i) => (
                  <div key={step.title} className="relative flex flex-col gap-2.5">
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-sm font-semibold tabular-nums text-primary ring-1 ring-inset ring-primary/20">
                      {i + 1}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-foreground">{step.title}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <aside className="flex flex-col gap-3">
            <SectionHeader
              title="Get set up"
              action={
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {doneCount}/{setupItems.length}
                </span>
              }
            />
            <div className="panel divide-y divide-border/70 overflow-hidden">
              {setupItems.map((item, i) => (
                <Link
                  key={item.label}
                  to={item.to}
                  className="group flex items-center gap-3 p-3.5 transition-colors hover:bg-secondary/40"
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold tabular-nums ring-1 ring-inset transition-colors',
                      item.done
                        ? 'bg-primary/15 text-primary ring-primary/30'
                        : 'bg-secondary/50 text-muted-foreground ring-border/70 group-hover:text-foreground'
                    )}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm font-semibold',
                        item.done ? 'text-muted-foreground line-through' : 'text-foreground'
                      )}
                    >
                      {item.label}
                    </span>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.desc}</p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 text-xs font-medium',
                      item.done ? 'text-muted-foreground' : 'text-muted-foreground group-hover:text-primary'
                    )}
                  >
                    {item.cta}
                  </span>
                </Link>
              ))}
            </div>
            {gmailConnected === null && (
              <p className="px-1 text-[11px] text-muted-foreground/70">
                Tip: a sharper profile and a connected inbox make your first drafts noticeably better.
              </p>
            )}
          </aside>
        </div>
      </div>
    );
  }

  // ---- Active dashboard ----
  // Which missions actually have drafts pending, so the focus card names them
  // (and links straight to the mission when there's only one).
  const draftMissions = missions.filter((m) => m.draft_count > 0);
  const draftMissionsSub =
    draftMissions.length > 0
      ? draftMissions.slice(0, 3).map((m) => m.name).join(' · ') +
        (draftMissions.length > 3 ? ` +${draftMissions.length - 3} more` : '')
      : 'Agent-written emails waiting for your eyes.';
  const focusItems = [
    stats.drafts > 0
      ? {
          key: 'drafts',
          count: stats.drafts,
          noun: stats.drafts === 1 ? 'draft to review' : 'drafts to review',
          sub: draftMissionsSub,
          to: draftMissions.length === 1 ? `/missions/${draftMissions[0].id}` : '/missions',
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
      <header className="relative flex flex-col gap-1.5">
        {/* Ambient glow whose hue tracks the time of day; gently breathes. */}
        {!reduceMotion && (
          <div
            aria-hidden
            className="pointer-events-none absolute -left-12 -top-16 -z-10 h-44 w-2/3 rounded-full opacity-40 blur-[90px]"
            style={{
              background: `radial-gradient(closest-side, hsl(${greet.accent} / 0.4), transparent)`,
              animation: 'mh-breathe 9s ease-in-out infinite',
              transition: 'background 1.5s ease',
            }}
          />
        )}
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          <span>{dateLabel}</span>
          <span className="text-muted-foreground/40">·</span>
          <span
            className="relative inline-flex h-1.5 w-1.5 items-center"
            aria-hidden
            title="Live"
          >
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/70" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          <span className="tabular-nums text-foreground/70">{timeLabel}</span>
        </span>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-[1.6rem] font-semibold leading-tight tracking-tight text-foreground">
            {firstName ? `${greet.label}, ${firstName}` : greet.label}
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
          {focusItems.map((f, i) => (
            <Link
              key={f.key}
              to={f.to}
              style={{ animationDelay: `${i * 80}ms` }}
              className="panel group flex items-center gap-4 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 motion-safe:animate-fade-in"
            >
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-xl font-bold tabular-nums text-primary ring-1 ring-inset ring-primary/20 transition-transform duration-200 group-hover:scale-105">
                <Counter value={f.count} animate={animateNums} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold text-foreground">{f.noun}</span>
                <span className="truncate text-xs text-muted-foreground">{f.sub}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground transition-colors group-hover:text-primary">
                <span className="hidden sm:inline">{f.cta}</span>
                <ArrowUpRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
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
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton-card">
                  <div className="skeleton-card-row">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="ml-auto h-5 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-2.5 w-full rounded-full" />
                  <div className="skeleton-card-row">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel divide-y divide-border/70 overflow-hidden">
              {missions.map((m, i) => {
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
                            className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                            style={{
                              width: `${reduceMotion || barsIn ? fillPct : 0}%`,
                              transitionDelay: `${i * 80}ms`,
                            }}
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
                    <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground/40 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-foreground sm:block" />
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
              <div className="panel flex flex-col items-center gap-1.5 px-3.5 py-8 text-center">
                <p className="text-sm font-medium text-foreground/90">No activity yet</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Agent runs — targeting, research, drafting — show up here as they happen.
                </p>
              </div>
            ) : (
              <div className="panel divide-y divide-border/60 overflow-hidden">
                {runs.map((r) => {
                  const v = describeRun(r);
                  return (
                    <div
                      key={r.id}
                      title={v.title}
                      className="flex items-center gap-2.5 px-3.5 py-2.5 transition-colors hover:bg-secondary/30"
                    >
                      <StatusDot tone={v.tone} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">{v.label}</span>
                      {v.tone === 'running' && (
                        <span className="shrink-0 text-[11px] font-medium text-primary">running…</span>
                      )}
                      {v.tone === 'failed' && (
                        <span className="shrink-0 text-[11px] font-medium text-destructive">{v.tag}</span>
                      )}
                      {v.tone === 'empty' && (
                        <span className="shrink-0 text-[11px] font-medium text-warning">{v.tag}</span>
                      )}
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{timeAgo(r.started_at)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader title="This week" />
            <dl className="panel grid grid-cols-3 divide-x divide-border/60 overflow-hidden">
              <StatCell icon={Users} label="Contacted" value={stats.contacted} animate={animateNums} />
              <StatCell icon={FileText} label="Drafts" value={stats.drafts} animate={animateNums} />
              <StatCell
                icon={Zap}
                label="Runs today"
                value={stats.runsToday}
                suffix="/50"
                warn={stats.runsToday >= 40}
                animate={animateNums}
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

function StatusDot({ tone }: { tone: RunTone }) {
  if (tone === 'running') {
    return (
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary shadow-[0_0_8px_0_hsl(153_45%_46%/0.8)]" />
      </span>
    );
  }
  const color =
    tone === 'failed' ? 'bg-destructive' : tone === 'empty' ? 'bg-warning' : 'bg-muted-foreground/40';
  return <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', color)} />;
}

function StatCell({
  icon: Icon,
  label,
  value,
  unit,
  suffix,
  warn,
  animate,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number | null;
  unit?: string;
  suffix?: string;
  warn?: boolean;
  animate?: boolean;
}) {
  return (
    <div className="group flex flex-col gap-2 px-3 py-3.5 transition-colors hover:bg-secondary/30">
      <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium uppercase text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0 transition-transform duration-200 group-hover:scale-110" /> {label}
      </span>
      <span className={cn('text-2xl font-semibold leading-none tabular-nums', warn ? 'text-warning' : 'text-foreground')}>
        {value === null ? '-' : <Counter value={value} animate={!!animate} unit={unit} />}
        {suffix && <span className="text-sm font-normal text-muted-foreground">{suffix}</span>}
      </span>
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
