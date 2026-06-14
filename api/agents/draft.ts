// Draft agent - the HTTP entry point to the personalization engine for a SINGLE
// draft (onboarding Stage-4 calibration, or one-off regeneration).
//
// The live bulk pipeline goes through sequence.ts (which also writes follow-ups
// + the email_sequences doc the rest of the app reads). Both share the same
// context assembly (api/_lib/assemble.ts) and the same pure engine; this handler
// just runs the engine and returns the result without persisting a sequence.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { runDraftEngine, type EngineTier } from '../_lib/engine';
import { resolvePersona, assembleDraftContext } from '../_lib/assemble';
import type { ContactDoc, MissionDoc, TargetDoc } from '../../shared/schemas';

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { contact_id, tier: tierRaw } = (req.body ?? {}) as { contact_id?: string; tier?: string };
  if (!contact_id) return res.status(400).json({ error: 'missing_contact_id' });
  // 'bulk' default (thin per-draft margin); 'onboarding' allows more revise loops.
  const tier: EngineTier = tierRaw === 'onboarding' ? 'onboarding' : 'bulk';

  const contact = await scope.collection<ContactDoc>('contacts').findById(contact_id);
  if (!contact) return res.status(404).json({ error: 'contact_not_found' });
  const target = await scope.collection<TargetDoc>('targets').findById(contact.targetId);
  if (!target) return res.status(404).json({ error: 'target_not_found' });
  const mission = await scope.collection<MissionDoc>('missions').findById(target.missionId);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  const persona = await resolvePersona(scope, mission.personaId);

  const run = await startRun(scope, {
    agentType: 'draft',
    missionId: mission._id,
    targetId: target._id,
    contactId: contact_id,
  });

  try {
    const { ctx, factIds, exemplarIds, personaVersion } = await assembleDraftContext(scope, user.id, {
      contact,
      target,
      mission,
      persona,
    });

    const result = await runDraftEngine(ctx, tier);

    // Observe - log the full grounding lineage so the learning loop + eval can
    // attribute outcomes back to specific facts/exemplars/persona version.
    await completeRun(scope, run._id, {
      persona_id: persona?._id ?? null,
      persona_version: personaVersion,
      tier,
      pass: result.pass,
      revisions: result.revisions,
      voice_match_score: result.voiceMatchScore,
      violations: result.violations,
      violation_count: result.violations.length,
      fact_ids: factIds,
      exemplar_ids: exemplarIds,
      claims: result.draft.claims,
    });

    return res.status(200).json({
      run_id: run._id,
      persona_id: persona?._id ?? null,
      draft: result.draft,
      violations: result.violations,
      voice_match_score: result.voiceMatchScore,
      revisions: result.revisions,
      pass: result.pass,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
