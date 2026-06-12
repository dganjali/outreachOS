// Campaign Autopilot sweeper. Cloud Scheduler hits this on a cadence (e.g.
// every ~30 min) with the cron secret. For each enabled policy it tops up
// discovery and auto-sends gate-cleared drafts within the policy's guardrails.
//
// Ops: add a Cloud Scheduler job → POST <service-url>/api/cron/autopilot with
// header `Authorization: Bearer ${CRON_SECRET}` (same pattern as the other crons).

import type { Request, Response } from 'express';
import { requireCronSecret } from '../_lib/auth';
import { runAutopilot } from '../_lib/autopilot';

export default async function handler(req: Request, res: Response) {
  if (!requireCronSecret(req, res)) return;
  const summary = await runAutopilot();
  return res.status(200).json(summary);
}
