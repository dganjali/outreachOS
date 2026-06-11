// Agent run telemetry + per-user rate limiting. Mongo edition.

import type { Response } from 'express';
import { newId, type InsertDoc, type UserScope } from './db';
import type { AgentRunDoc } from '../../shared/schemas';

// The mission pipeline legitimately fires ~12 agent calls/minute (evidence →
// contacts → sequence per target, ~5s each), so the per-minute cap must sit
// above that or the app rate-limits its own orchestrator mid-run. The daily
// cap is the real cost guard (one full pipeline launch ≈ 16 runs).
const RATE_PER_MINUTE = 20;
const RATE_PER_DAY = 150;

export type AgentType = AgentRunDoc['agentType'];

export async function checkRateLimit(scope: UserScope, res: Response): Promise<boolean> {
  const now = Date.now();
  const minuteAgo = new Date(now - 60_000);
  const dayAgo = new Date(now - 86_400_000);

  const runs = scope.collection<AgentRunDoc>('agent_runs');
  const [perMinute, perDay] = await Promise.all([
    runs.countDocuments({ startedAt: { $gte: minuteAgo } }),
    runs.countDocuments({ startedAt: { $gte: dayAgo } }),
  ]);

  if (perMinute >= RATE_PER_MINUTE) {
    res.status(429).json({ error: 'rate_limit_exceeded', detail: 'Too many requests — wait a minute and retry.' });
    return false;
  }
  if (perDay >= RATE_PER_DAY) {
    res.status(429).json({ error: 'rate_limit_exceeded', detail: 'Daily agent run limit reached.' });
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
