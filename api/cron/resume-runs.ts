// Pipeline resume sweeper. Cloud Scheduler hits this every ~2 min with the cron
// secret. It finds live runs (pending/running) whose driver has gone silent and
// re-drives them.
//
// Why this exists: a run is driven in-process by whichever instance started it,
// and `resumeIfStale` otherwise only fires on a client poll of GET
// /api/agents/pipeline. So a run stalls the moment the user's tab closes (or
// navigates away, or the instance is recycled) - nothing re-drives it. This
// sweep is the server-side equivalent of that poll, so a mission finishes
// unattended. Idempotent: a run still being driven elsewhere keeps a fresh
// heartbeat and is skipped by the staleness filter.

import type { Request, Response } from 'express';
import { adminDb } from '../_lib/db';
import { requireCronSecret } from '../_lib/auth';
import { driveStaleRun, STALE_HEARTBEAT_MS } from '../_lib/pipeline';
import type { PipelineRunDoc } from '../../shared/schemas';

// Bounded per tick. Runs are driven concurrently (independent users), so wall
// time is ~the slowest run, not the sum. Anything not finished this tick keeps
// its persisted progress and is picked up by a later sweep once stale again.
const BATCH = 8;
const CONCURRENCY = 3;

export default async function handler(req: Request, res: Response) {
  if (!requireCronSecret(req, res)) return;

  const db = await adminDb();
  const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS);
  const stale = await db
    .collection<PipelineRunDoc>('pipeline_runs')
    .find({ status: { $in: ['pending', 'running'] }, heartbeatAt: { $lt: cutoff } })
    .sort({ heartbeatAt: 1 })
    .limit(BATCH)
    .toArray();

  let resumed = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    const slice = stale.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (run) => {
        const uid = (run as PipelineRunDoc & { userId: string }).userId;
        try {
          if (await driveStaleRun({ id: uid, email: null }, run._id)) resumed++;
        } catch (err) {
          errors.push({ id: run._id, error: err instanceof Error ? err.message : 'resume_failed' });
        }
      }),
    );
  }

  return res.status(200).json({ stale: stale.length, resumed, errors });
}
