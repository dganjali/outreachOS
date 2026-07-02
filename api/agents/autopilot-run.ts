// Manual "cycle now": kick off a sourcing run for one mission on demand instead
// of waiting for the hourly autopilot cron. Mirrors the sourcing step of
// api/cron/autopilot-tick.ts, but scoped to the caller's own mission - the
// escape hatch when "Next sourcing: due now" has been stuck because the cron
// hasn't advanced (e.g. a wedged run).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { resumeIfStale } from '../_lib/pipeline';
import { buildRecipeStages, resolveRecipe, insertRecipe, policyView, type RecipeStages } from '../_lib/recipe';
import { startSourcing, gateAndQueue, type AutopilotCtx } from '../cron/autopilot-tick';
import type { MissionRecipeDoc, PipelineRunDoc } from '../../shared/schemas';

interface GateTally {
  policyId: string;
  sourced: boolean;
  gated: number;
  queued: number;
  reviewed: number;
  ready: number;
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { mission_id } = (req.body ?? {}) as { mission_id?: string };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission' });

  // Load the mission's recipe (the single source of truth). If it hasn't been
  // migrated yet, synthesize + persist one now so subsequent writes have a home.
  let recipeDoc = await scope.collection<MissionRecipeDoc>('mission_recipes').findOne({ missionId: mission_id });
  let stages: RecipeStages;
  if (recipeDoc) {
    stages = buildRecipeStages({ mission: { findMode: recipeDoc.sourcing?.findMode ?? null }, partial: recipeDoc });
  } else {
    stages = await resolveRecipe(scope, mission_id);
    recipeDoc = await insertRecipe(scope, mission_id, stages);
  }
  const ctx: AutopilotCtx = { recipeId: recipeDoc._id, missionId: mission_id, view: policyView(stages), send: stages.send };

  const now = new Date();

  // Gate any drafts already sitting un-verdicted (verified → queued/ready, the
  // rest → review) so pressing "cycle now" moves the queue immediately instead of
  // waiting up to an hour for the cron. Best-effort: a gate hiccup must not block
  // the sourcing kickoff below.
  const tally: GateTally = { policyId: ctx.recipeId, sourced: false, gated: 0, queued: 0, reviewed: 0, ready: 0 };
  try {
    await gateAndQueue(scope, ctx, now, tally);
  } catch (err) {
    console.error('[autopilot] cycle-now gate failed', ctx.recipeId, err);
  }

  // A run is already live ⇒ don't start a duplicate; just nudge it forward if it
  // has gone silent. Sourcing is effectively already in progress.
  const liveRuns = (await scope
    .collection<PipelineRunDoc>('pipeline_runs')
    .find({ missionId: mission_id, status: { $in: ['pending', 'running'] } as never })) as PipelineRunDoc[];
  if (liveRuns.length > 0) {
    for (const r of liveRuns) resumeIfStale({ id: user.id, email: user.email ?? null }, r);
    return res.status(200).json({ sourcing: 'in_progress', gated: tally.gated, queued: tally.queued });
  }

  await startSourcing(scope, user.id, mission_id, stages);
  await scope
    .collection<MissionRecipeDoc>('mission_recipes')
    .updateById(ctx.recipeId, { send: { ...stages.send, lastSourcedAt: now } });
  return res
    .status(200)
    .json({ sourcing: 'started', last_sourced_at: now.toISOString(), gated: tally.gated, queued: tally.queued });
}
