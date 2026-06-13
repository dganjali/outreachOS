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
export async function checkRateLimit(scope: UserScope, res: Response): Promise<boolean> {
  const now = Date.now();
  const minuteAgo = new Date(now - 60_000);
  const dayAgo = new Date(now - 86_400_000);

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
      detail: 'Too many requests — wait a minute and retry.',
    });
    return false;
  }
  if (perDay >= limits.agentRunsPerDay) {
    res.status(429).json({
      error: 'rate_limit_exceeded',
      scope: 'daily',
      detail: `Daily agent-run limit reached (${limits.agentRunsPerDay}/day on your plan). Upgrade for more.`,
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

/** How many launches the caller has used this month, and their plan's cap. */
async function missionUsage(scope: UserScope): Promise<{ used: number; limit: number }> {
  const profile = await scope.collection<ProfileDoc>('profiles').findOne({});
  const limit = planLimits(profile?.plan, profile?.planStatus).missionsPerMonth;
  const q = profile?.missionQuota;
  const used = q && q.period === currentMonthKey() ? q.used : 0;
  return { used, limit };
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
  if (!profile) return; // no profile (legacy/edge) — nothing to stamp against
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

export async function completeRun(scope: UserScope, id: string, output: Record<string, unknown>) {
  await scope.collection<AgentRunDoc>('agent_runs').updateById(id, {
    status: 'completed',
    output,
    completedAt: new Date(),
  });
}

export async function failRun(scope: UserScope, id: string, error: string) {
  await scope.collection<AgentRunDoc>('agent_runs').updateById(id, {
    status: 'failed',
    error,
    completedAt: new Date(),
  });
}
