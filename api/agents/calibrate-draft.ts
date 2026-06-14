// Calibrate-draft agent — generates ONE real draft for the persona-onboarding
// calibration step. Instead of asking the user to write/paste an email, we grab
// a real contact they already have and run the full personalization engine once,
// so calibration starts from a genuine draft to react to.
//
// Unlike draft.ts (which drafts as the *contact's mission* persona), this forces
// the persona currently being calibrated, so the onboarding draft reflects the
// voice under construction — facts, exemplars, and style profile all included.
// Returns the draft + recipient; the wizard then lets the user refine it (whole
// draft or a highlighted span) and every instruction is learned as taste.
//
// No resolvable contact yet (fresh account) → `{ none: true }`, and the client
// falls back to the paste-your-own-draft flow.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { runDraftEngine } from '../_lib/engine';
import { assembleDraftContext } from '../_lib/assemble';
import type { ContactDoc, MissionDoc, PersonaDoc, TargetDoc } from '../../shared/schemas';

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { persona_id } = (req.body ?? {}) as { persona_id?: string };
  if (!persona_id) return res.status(400).json({ error: 'missing_persona_id' });

  const persona = await scope.collection<PersonaDoc>('personas').findById(persona_id);
  if (!persona) return res.status(404).json({ error: 'persona_not_found' });

  // Most-recent contact we can fully resolve (contact→target→mission). No
  // contacts yet → signal the client to fall back to manual paste.
  const contacts = await scope.collection<ContactDoc>('contacts').find({});
  contacts.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

  let picked: { contact: ContactDoc; target: TargetDoc; mission: MissionDoc } | null = null;
  for (const contact of contacts) {
    const target = await scope.collection<TargetDoc>('targets').findById(contact.targetId);
    if (!target) continue;
    const mission = await scope.collection<MissionDoc>('missions').findById(target.missionId);
    if (!mission) continue;
    picked = { contact, target, mission };
    break;
  }
  if (!picked) return res.status(200).json({ none: true });

  const { contact, target, mission } = picked;
  const run = await startRun(scope, {
    agentType: 'draft',
    missionId: mission._id,
    targetId: target._id,
    contactId: contact._id,
  });

  try {
    const { ctx, factIds, exemplarIds, personaVersion } = await assembleDraftContext(scope, user.id, {
      contact,
      target,
      mission,
      persona, // force the persona being calibrated, NOT mission.personaId
    });

    const result = await runDraftEngine(ctx, 'onboarding');

    // Observe — same grounding lineage as draft.ts so the learning loop + eval
    // can attribute outcomes back to specific facts/exemplars/persona version.
    await completeRun(scope, run._id, {
      persona_id: persona._id,
      persona_version: personaVersion,
      tier: 'onboarding',
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
      recipient: { name: contact.name, role: contact.role, company: target.companyName },
      subject: result.draft.subject,
      body: result.draft.body,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
