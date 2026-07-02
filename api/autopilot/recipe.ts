// Mission Recipe endpoints - the frontend's read/write surface for the modular
// pipeline definition (Phase 3). Both the manual Setup tab and the Autopilot
// cockpit use these, so the two edit the same recipe.
//
//   GET  /api/autopilot/recipe?mission_id=…  → the mission's recipe (created +
//        self-healed if missing/partial), snake_cased for the client.
//   POST /api/autopilot/recipe { mission_id, patch } → apply a stage patch
//        (merged + clamped via applyRecipePatch), persist, reschedule queued
//        sends on a window/timezone change, and return the updated recipe.
//
// The patch arrives snake_cased (the client sends its MissionRecipe shape); we
// deep-camelCase it to the RecipeStagesPatch the pure logic reads.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import {
  getOrCreateRecipe,
  applyRecipePatch,
  upsertRecipe,
  resolveRecipe,
  policyView,
  type RecipeStagesPatch,
} from '../_lib/recipe';
import { deepCamelKeys } from '../_lib/steer';
import { rescheduleQueuedSends } from '../_lib/reschedule';
import type { MissionDoc, MissionRecipeDoc } from '../../shared/schemas';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  if (req.method === 'GET') {
    const missionId = req.query.mission_id as string | undefined;
    if (!missionId) return res.status(400).json({ error: 'missing_mission_id' });
    const mission = await scope.collection<MissionDoc>('missions').findById(missionId);
    if (!mission) return res.status(404).json({ error: 'mission_not_found' });
    const recipe = await getOrCreateRecipe(scope, missionId);
    return res.status(200).json({ data: serialize(recipe) });
  }

  if (req.method === 'POST') {
    const { mission_id, patch: rawPatch } = (req.body ?? {}) as { mission_id?: string; patch?: unknown };
    if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });
    const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
    if (!mission) return res.status(404).json({ error: 'mission_not_found' });

    const patch = deepCamelKeys(rawPatch ?? {}) as RecipeStagesPatch;
    const current = await resolveRecipe(scope, mission_id);
    const next = applyRecipePatch(current, patch);
    const doc = await upsertRecipe(scope, mission_id, next);

    // A window/timezone change must move already-queued sends into the new window.
    if (patch.send?.sendWindow || patch.send?.timezone) {
      await rescheduleQueuedSends(scope, mission_id, policyView(next), new Date());
    }
    return res.status(200).json({ data: serialize(doc) });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}

/** Shape the doc for the client: `id` instead of `_id`; authedFetch snake_cases
 *  the rest (including nested stage keys) on the way out. */
function serialize(r: MissionRecipeDoc) {
  return {
    id: r._id,
    mission_id: r.missionId,
    automationEnabled: r.automationEnabled,
    sourcing: r.sourcing,
    verification: r.verification,
    research: r.research,
    personSourcing: r.personSourcing,
    sequencing: r.sequencing,
    send: r.send,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}
