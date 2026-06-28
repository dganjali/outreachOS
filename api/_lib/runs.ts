// Agent run telemetry + per-user, plan-aware rate limiting. Mongo edition.

import type { Response } from 'express';
import { newId, type InsertDoc, type UserScope } from './db';
import type { AgentRunDoc, ProfileDoc } from '../../shared/schemas';
import { planLimits, type PlanLimits } from '../../shared/plans';

export type AgentType = AgentRunDoc['agentType'];

/**
 * Resolve the caller's effective plan limits from their profile. Falls back to
 * the free tier when the profile is missing or has no plan (legacy users).
 * Limits live in shared/plans.ts so the client can show them too.
 */
export async function getPlanLimits(scope: UserScope): Promise<PlanLimits> {
  const profile = await scope.collection<ProfileDoc>('profiles').findOne({});
  return planLimits(profile?.plan, profile?.planStatus);
}

/**
 * 429s the request (and returns false) if the caller is over their agent-run
 * budget. The per-minute cap is a burst guard; the per-day cap is the real cost
 * guard. Both scale with the user's plan. A 'daily' code in the response lets
 * the client distinguish "wait a minute" from "you're out for the day → upgrade".
 */
const DAY_MS = 86_400_000;

/**
 * When the daily agent-run cap will free up enough for one more call. The cap is
 * a SLIDING 24h window (not a midnight reset), so capacity returns as the oldest
 * runs age out. This is the moment the rolling count drops back below the plan
 * limit: the run that must expire is the `(perDay - limit + 1)`-th oldest still
 * inside the window, and capacity returns 24h after it started. Returns null when
 * the caller isn't actually over the cap or the window is unexpectedly empty.
 */
export async function dailyResetAt(
  scope: UserScope,
  limit: number,
  perDay: number,
  now: number = Date.now()
): Promise<Date | null> {
  if (perDay < limit) return null;
  const ageOutCount = perDay - limit + 1; // runs that must expire to get back under cap
  const oldest = await scope.collection<AgentRunDoc>('agent_runs').find(
    { startedAt: { $gte: new Date(now - DAY_MS) } },
    { sort: { startedAt: 1 }, limit: ageOutCount }
  );
  const pivot = oldest[oldest.length - 1];
  if (!pivot?.startedAt) return null;
  return new Date(new Date(pivot.startedAt).getTime() + DAY_MS);
}

export async function checkRateLimit(scope: UserScope, res: Response): Promise<boolean> {
  const now = Date.now();
  const minuteAgo = new Date(now - 60_000);
  const dayAgo = new Date(now - DAY_MS);

  const runs = scope.collection<AgentRunDoc>('agent_runs');
  const [limits, perMinute, perDay] = await Promise.all([
    getPlanLimits(scope),
    runs.countDocuments({ startedAt: { $gte: minuteAgo } }),
    runs.countDocuments({ startedAt: { $gte: dayAgo } }),
  ]);

  if (perMinute >= limits.agentRunsPerMinute) {
    res.status(429).json({
      error: 'rate_limit_exceeded',
      scope: 'minute',
      detail: 'Too many requests - wait a minute and retry.',
    });
    return false;
  }
  if (perDay >= limits.agentRunsPerDay) {
    const resetAt = await dailyResetAt(scope, limits.agentRunsPerDay, perDay, now);
    res.status(429).json({
      error: 'rate_limit_exceeded',
      scope: 'daily',
      // Keep the word "daily" so callers (pipeline classify) can detect it.
      detail: `Daily agent-run limit reached (${limits.agentRunsPerDay}/day on your plan).${
        resetAt ? ` Resets ${resetAt.toISOString()}.` : ''
      } Upgrade for more.`,
      // ISO timestamp so the client can render it in the user's local time.
      resetAt: resetAt ? resetAt.toISOString() : null,
    });
    return false;
  }
  return true;
}

// --- Monthly mission-launch cap (the headline plan metric) -------------------
//
// The cap is enforced against a monotonic per-month counter on the profile
// (missionQuota), NOT a live count of mission docs. That is the whole point: if
// we counted current missions, deleting one would free up a slot and a user
// could mint unlimited missions by repeatedly deleting and recreating. The
// counter is only ever incremented (on create) and lazily reset at a month
// boundary, so a delete never gives quota back.

/** UTC 'YYYY-MM' key for the calendar month a count applies to. */
function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Mission launches used in the current month, read from the monotonic counter
 * on the profile - the same source checkMissionQuota enforces against. Pure (no
 * DB), so callers that already hold the profile (e.g. billing /me) can reuse it
 * instead of counting mission docs, which would diverge from enforcement the
 * moment a mission is deleted.
 */
export function missionsUsedThisMonth(profile: Pick<ProfileDoc, 'missionQuota'> | null | undefined): number {
  const q = profile?.missionQuota;
  return q && q.period === currentMonthKey() ? q.used : 0;
}

/** How many launches the caller has used this month, and their plan's cap. */
async function missionUsage(scope: UserScope): Promise<{ used: number; limit: number }> {
  const profile = await scope.collection<ProfileDoc>('profiles').findOne({});
  const limit = planLimits(profile?.plan, profile?.planStatus).missionsPerMonth;
  return { used: missionsUsedThisMonth(profile), limit };
}

/**
 * 429s (and returns false) if the caller is at their monthly mission cap.
 * Called from the data router before a mission insert.
 */
export async function checkMissionQuota(scope: UserScope, res: Response): Promise<boolean> {
  const { used, limit } = await missionUsage(scope);
  if (used >= limit) {
    res.status(429).json({
      error: 'mission_quota_exceeded',
      scope: 'monthly',
      detail: `Monthly mission limit reached (${limit}/month on your plan). Upgrade to launch more.`,
    });
    return false;
  }
  return true;
}

/**
 * Record one mission launch against the monthly counter. Call AFTER a
 * successful mission insert. Resets the counter when the stored period is a
 * prior month. Never decremented elsewhere, so deletes can't refund quota.
 */
export async function incrementMissionQuota(scope: UserScope): Promise<void> {
  const profiles = scope.collection<ProfileDoc>('profiles');
  const profile = await profiles.findOne({});
  if (!profile) return; // no profile (legacy/edge) - nothing to stamp against
  const period = currentMonthKey();
  const q = profile.missionQuota;
  const used = q && q.period === period ? q.used + 1 : 1;
  await profiles.updateOne({}, { missionQuota: { period, used } } as Partial<ProfileDoc>);
}

export async function startRun(
  scope: UserScope,
  args: {
    agentType: AgentType;
    missionId?: string | null;
    targetId?: string | null;
    contactId?: string | null;
    input?: Record<string, unknown>;
  }
): Promise<AgentRunDoc> {
  const now = new Date();
  const doc = await scope.collection<AgentRunDoc>('agent_runs').insertOne({
    _id: newId(),
    agentType: args.agentType,
    missionId: args.missionId ?? null,
    targetId: args.targetId ?? null,
    contactId: args.contactId ?? null,
    input: args.input ?? null,
    output: null,
    error: null,
    status: 'running',
    startedAt: now,
    completedAt: null,
  } as InsertDoc<AgentRunDoc>);
  return doc as AgentRunDoc;
}

// --- Agent-run analytics -----------------------------------------------------
//
// Read-side rollups over the agent_runs telemetry the start/complete/fail
// helpers above write. Everything is aggregated server-side (Mongo $facet) and
// scoped to the caller by scope.aggregate()'s injected userId $match. Note the
// data only goes back as far as the agent_runs TTL (30 days), so windows are
// capped accordingly. Day bucketing is UTC.

export interface RunTypeStat {
  agentType: AgentType;
  runs: number;
  completed: number;
  failed: number;
  running: number;
  /** Mean duration of completed runs, ms. 0 when none completed. */
  avgMs: number;
  /** 95th-percentile duration of completed runs, ms. */
  p95Ms: number;
  /** completed / (completed + failed), 0-1. Excludes still-running. */
  successRate: number;
}

export interface RunDayStat {
  /** UTC 'YYYY-MM-DD'. */
  day: string;
  runs: number;
  completed: number;
  failed: number;
}

export interface RunAnalytics {
  windowDays: number;
  totals: {
    runs: number;
    completed: number;
    failed: number;
    running: number;
    successRate: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
  };
  byType: RunTypeStat[];
  byDay: RunDayStat[];
}

/** Nearest-rank percentile of a pre-sorted ascending array. Empty ⇒ 0. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length, Math.max(1, rank)) - 1;
  return Math.round(sortedAsc[idx]);
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

/** UTC 'YYYY-MM-DD' for a Date. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Every UTC day key from `since` (inclusive) to today, ascending. */
function dayRange(since: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  const today = new Date();
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  while (cur.getTime() <= end) {
    out.push(dayKey(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

interface TypeFacetRow {
  _id: AgentType;
  runs: number;
  completed: number;
  failed: number;
  running: number;
  durations: (number | null)[];
}
interface DayFacetRow {
  _id: string;
  runs: number;
  completed: number;
  failed: number;
}

/**
 * Rollup of the caller's agent runs over the last `windowDays` (1-30, clamped to
 * the agent_runs TTL). One round trip: a $facet computes the per-type and
 * per-day groupings; percentiles are finished in Node over the (single-user,
 * bounded) duration arrays.
 */
export async function agentRunAnalytics(scope: UserScope, windowDays = 30): Promise<RunAnalytics> {
  const days = Math.max(1, Math.min(30, Math.floor(windowDays) || 30));
  const since = new Date(Date.now() - days * 86_400_000);

  // Duration of a finished run, else null (still-running rows have no end).
  const durationMs = {
    $cond: [
      { $ifNull: ['$completedAt', false] },
      { $subtract: ['$completedAt', '$startedAt'] },
      null,
    ],
  };
  const countWhen = (status: string) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });

  const [facet] = await scope.collection<AgentRunDoc>('agent_runs').aggregate<{
    byType: TypeFacetRow[];
    byDay: DayFacetRow[];
  }>([
    { $match: { startedAt: { $gte: since } } },
    { $addFields: { _durationMs: durationMs } },
    {
      $facet: {
        byType: [
          {
            $group: {
              _id: '$agentType',
              runs: { $sum: 1 },
              completed: countWhen('completed'),
              failed: countWhen('failed'),
              running: countWhen('running'),
              durations: { $push: '$_durationMs' },
            },
          },
        ],
        byDay: [
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: 'UTC' } },
              runs: { $sum: 1 },
              completed: countWhen('completed'),
              failed: countWhen('failed'),
            },
          },
        ],
      },
    },
  ]);

  const typeRows = facet?.byType ?? [];
  const dayRows = facet?.byDay ?? [];

  // Per-type stats + a flat list of all completed-run durations for the totals.
  const allDurations: number[] = [];
  const byType: RunTypeStat[] = typeRows
    .map((r): RunTypeStat => {
      const durs = (r.durations ?? []).filter((d): d is number => typeof d === 'number' && d >= 0).sort((a, b) => a - b);
      allDurations.push(...durs);
      const settled = r.completed + r.failed;
      return {
        agentType: r._id,
        runs: r.runs,
        completed: r.completed,
        failed: r.failed,
        running: r.running,
        avgMs: mean(durs),
        p95Ms: percentile(durs, 95),
        successRate: settled === 0 ? 0 : r.completed / settled,
      };
    })
    .sort((a, b) => b.runs - a.runs);

  allDurations.sort((a, b) => a - b);

  const dayMap = new Map(dayRows.map((d) => [d._id, d]));
  const byDay: RunDayStat[] = dayRange(since).map((day) => {
    const d = dayMap.get(day);
    return { day, runs: d?.runs ?? 0, completed: d?.completed ?? 0, failed: d?.failed ?? 0 };
  });

  const totalsRuns = byType.reduce((s, t) => s + t.runs, 0);
  const totalsCompleted = byType.reduce((s, t) => s + t.completed, 0);
  const totalsFailed = byType.reduce((s, t) => s + t.failed, 0);
  const totalsRunning = byType.reduce((s, t) => s + t.running, 0);
  const settledTotal = totalsCompleted + totalsFailed;

  return {
    windowDays: days,
    totals: {
      runs: totalsRuns,
      completed: totalsCompleted,
      failed: totalsFailed,
      running: totalsRunning,
      successRate: settledTotal === 0 ? 0 : totalsCompleted / settledTotal,
      avgMs: mean(allDurations),
      p50Ms: percentile(allDurations, 50),
      p95Ms: percentile(allDurations, 95),
    },
    byType,
    byDay,
  };
}

export async function completeRun(scope: UserScope, id: string, output: Record<string, unknown>) {
  await scope.collection<AgentRunDoc>('agent_runs').updateById(id, {
    status: 'completed',
    output,
    completedAt: new Date(),
  });
}

export async function failRun(
  scope: UserScope,
  id: string,
  error: string,
  output?: Record<string, unknown>,
) {
  // `output` carries the same kind of decision-log telemetry as completeRun, so
  // a FAILED run is just as debuggable as a successful one (e.g. which stage of
  // contact discovery lost the company). Optional + back-compatible.
  await scope.collection<AgentRunDoc>('agent_runs').updateById(id, {
    status: 'failed',
    error,
    output: output ?? null,
    completedAt: new Date(),
  });
}
