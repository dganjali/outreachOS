// GET /api/billing/me - current plan + live usage for the signed-in user.
// Powers the Plan & Billing UI (current plan, usage meters, renewal date).

import type { Request, Response } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser } from '../_lib/db';
import type { ProfileDoc, AgentRunDoc } from '../../shared/schemas';
import { resolvePlan, planLimits, DEFAULT_PLAN } from '../../shared/plans';
import { missionsUsedThisMonth } from '../_lib/runs';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;

  const scope = forUser(user.id);
  const profile = await scope.collection<ProfileDoc>('profiles').findOne({});

  const plan = resolvePlan(profile?.plan, profile?.planStatus);
  const limits = planLimits(profile?.plan, profile?.planStatus);

  const dayAgo = new Date(Date.now() - 86_400_000);

  // Mission usage comes from the monotonic monthly counter (the same source
  // checkMissionQuota enforces against) - NOT a live count of mission docs,
  // which would under-report after a delete and mislead a paying user.
  const runsToday = await scope.collection<AgentRunDoc>('agent_runs').countDocuments({ startedAt: { $gte: dayAgo } });
  const missionsThisMonth = missionsUsedThisMonth(profile);

  return res.json({
    plan, // effective plan id (free if canceled/incomplete)
    purchasedPlan: profile?.plan ?? DEFAULT_PLAN,
    planStatus: profile?.planStatus ?? null,
    planRenewsAt: profile?.planRenewsAt ?? null,
    hasBillingAccount: Boolean(profile?.stripeCustomerId),
    limits,
    usage: {
      missionsThisMonth,
      runsToday,
    },
  });
}
