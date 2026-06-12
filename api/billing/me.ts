// GET /api/billing/me — current plan + live usage for the signed-in user.
// Powers the Plan & Billing UI (current plan, usage meters, renewal date).

import type { Request, Response } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser } from '../_lib/db';
import type { ProfileDoc, AgentRunDoc } from '../../shared/schemas';
import { resolvePlan, planLimits, DEFAULT_PLAN } from '../../shared/plans';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;

  const scope = forUser(user.id);
  const profile = await scope.collection<ProfileDoc>('profiles').findOne({});

  const plan = resolvePlan(profile?.plan, profile?.planStatus);
  const limits = planLimits(profile?.plan, profile?.planStatus);

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [runsToday, missionsThisMonth] = await Promise.all([
    scope.collection<AgentRunDoc>('agent_runs').countDocuments({ startedAt: { $gte: dayAgo } }),
    scope.collection('missions').countDocuments({ createdAt: { $gte: monthStart } }),
  ]);

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
