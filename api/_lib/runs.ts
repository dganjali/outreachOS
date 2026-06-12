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

/**
 * Enforce the monthly mission-launch cap (the headline plan metric). Counts
 * missions created since the start of the current UTC month and 429s if the
 * caller is at their plan limit. Called from the data router on mission insert.
 */
export async function checkMissionQuota(scope: UserScope, res: Response): Promise<boolean> {
  const limits = await getPlanLimits(scope);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const used = await scope.collection('missions').countDocuments({ createdAt: { $gte: monthStart } });
  if (used >= limits.missionsPerMonth) {
    res.status(429).json({
      error: 'mission_quota_exceeded',
      scope: 'monthly',
      detail: `Monthly mission limit reached (${limits.missionsPerMonth}/month on your plan). Upgrade to launch more.`,
    });
    return false;
  }
  return true;
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
