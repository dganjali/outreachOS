// Manual "cycle now": kick off a sourcing run for one mission on demand instead
// of waiting for the hourly autopilot cron. Mirrors the sourcing step of
// api/cron/autopilot-tick.ts, but scoped to the caller's own mission - the
// escape hatch when "Next sourcing: due now" has been stuck because the cron
// hasn't advanced (e.g. a wedged run).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { resumeIfStale } from '../_lib/pipeline';
import { withPolicyDefaults } from '../_lib/autopilot';
import { startSourcing } from '../cron/autopilot-tick';
import type { CampaignPolicyDoc, PipelineRunDoc } from '../../shared/schemas';

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { mission_id } = (req.body ?? {}) as { mission_id?: string };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission' });

  const raw = await scope.collection<CampaignPolicyDoc>('campaign_policies').findOne({ missionId: mission_id });
  if (!raw) return res.status(404).json({ error: 'no_policy' });
  const policy: CampaignPolicyDoc = { ...raw, ...withPolicyDefaults(raw) };

  // A run is already live ⇒ don't start a duplicate; just nudge it forward if it
  // has gone silent. Sourcing is effectively already in progress.
  const liveRuns = (await scope
    .collection<PipelineRunDoc>('pipeline_runs')
    .find({ missionId: mission_id, status: { $in: ['pending', 'running'] } as never })) as PipelineRunDoc[];
  if (liveRuns.length > 0) {
    for (const r of liveRuns) resumeIfStale({ id: user.id, email: user.email ?? null }, r);
    return res.status(200).json({ sourcing: 'in_progress' });
  }

  const now = new Date();
  await startSourcing(scope, user.id, policy);
  await scope.collection<CampaignPolicyDoc>('campaign_policies').updateById(policy._id, { lastSourcedAt: now });
  return res.status(200).json({ sourcing: 'started', last_sourced_at: now.toISOString() });
}
