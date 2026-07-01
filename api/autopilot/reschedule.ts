// POST /api/autopilot/reschedule { mission_id }
//
// Recompute the send schedule for a mission's still-queued sends after its send
// window or timezone changed, so already-scheduled emails move into the new
// window instead of firing at their old (now off-hours) times. The client calls
// this right after persisting a send_window / timezone change.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { withPolicyDefaults } from '../_lib/autopilot';
import { rescheduleQueuedSends } from '../_lib/reschedule';
import type { CampaignPolicyDoc, MissionDoc } from '../../shared/schemas';

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { mission_id } = (req.body ?? {}) as { mission_id?: string };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

  const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  const policy = await scope.collection<CampaignPolicyDoc>('campaign_policies').findOne({ missionId: mission_id });
  if (!policy) return res.status(200).json({ ok: true, rescheduled: 0 });

  const normalized = withPolicyDefaults(policy);
  const rescheduled = await rescheduleQueuedSends(scope, mission_id, normalized, new Date());
  return res.status(200).json({ ok: true, rescheduled });
}
