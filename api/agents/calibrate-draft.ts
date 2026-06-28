// Calibrate-draft agent - generates ONE real draft for the voice calibration
// step. Instead of asking the user to write/paste an email, we run the full
// personalization engine once so calibration always starts from a genuine draft
// to react to.
//
// A voice carries only style (no offer/audience), so the offer + audience the
// draft is calibrated against comes from one of two entry points:
//   • STANDALONE  - the voice wizard passes a typed `sample` {offer, audience,
//     geo}. Grounding is the person-level memory bank only (no mission facts).
//   • PER-MISSION - the caller passes `mission_id`. Offer/audience/geo and the
//     allowed-fact bank come from that mission. If the mission already has a real
//     contact we draft on it; otherwise we synthesize a representative recipient.
//   • LEGACY (neither) - falls back to the most-recent mission matching the
//     voice's mode, mirroring the old behavior.
//
// The user never has to write their own email - they only give feedback, which
// is learned as taste via extract-style (chat_instructions → StyleProfile).
//
// Unlike draft.ts (which drafts as the *contact's mission* persona), this forces
// the persona currently being calibrated, so the calibration draft reflects the
// voice under construction - exemplars and style profile included.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { runDraftEngine, type AssembledContext } from '../_lib/engine';
import { assembleDraftContext, assembleAllowedFacts, fetchExemplars } from '../_lib/assemble';
import { defaultContactIcp } from '../_lib/icp';
import { generateJson, MODEL } from '../_lib/llm';
import { emptyStyleProfile } from '../../shared/schemas';
import type { ContactDoc, MissionDoc, PersonaDoc, ProfileDoc, TargetDoc } from '../../shared/schemas';
import type { MissionMode } from '../../shared/types';

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { persona_id, mission_id, sample } = (req.body ?? {}) as {
    persona_id?: string;
    mission_id?: string;
    sample?: { offer?: string; audience?: string; geo?: string | null };
  };
  if (!persona_id) return res.status(400).json({ error: 'missing_persona_id' });

  const persona = await scope.collection<PersonaDoc>('personas').findById(persona_id);
  if (!persona) return res.status(404).json({ error: 'persona_not_found' });

  // Per-mission entry point: anchor on a specific mission's offer/audience/bank.
  let explicitMission: MissionDoc | null = null;
  if (mission_id) {
    explicitMission = await scope.collection<MissionDoc>('missions').findById(mission_id);
    if (!explicitMission) return res.status(404).json({ error: 'mission_not_found' });
  }

  // Standalone: a typed sample drives the draft, so we deliberately skip Path A
  // (a real contact) - the point is to react to the sample, not a stale lead.
  const hasSample = !!sample && Boolean(sample.offer?.trim() || sample.audience?.trim());
  const standalone = !mission_id && hasSample;

  // Path A picks a real contact to draft on. With mission_id we restrict to that
  // mission; without it (legacy) we prefer this voice's own mission, else mode.
  let picked: { contact: ContactDoc; target: TargetDoc; mission: MissionDoc } | null = null;
  if (!standalone) {
    const contacts = await scope.collection<ContactDoc>('contacts').find({});
    contacts.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    let modeMatch: { contact: ContactDoc; target: TargetDoc; mission: MissionDoc } | null = null;
    for (const contact of contacts) {
      const target = await scope.collection<TargetDoc>('targets').findById(contact.targetId);
      if (!target) continue;
      const mission = await scope.collection<MissionDoc>('missions').findById(target.missionId);
      if (!mission) continue;
      if (mission_id) {
        // Per-mission: only contacts under THIS mission qualify.
        if (mission._id === mission_id) {
          picked = { contact, target, mission };
          break;
        }
        continue;
      }
      // Legacy: best is a contact under a mission that uses this exact voice.
      if (mission.personaId && mission.personaId === persona._id) {
        picked = { contact, target, mission };
        break;
      }
      // Fallback: same outreach mode. Keep the most-recent, keep scanning.
      if (!modeMatch && persona.mode && mission.mode === persona.mode) {
        modeMatch = { contact, target, mission };
      }
    }
    if (!picked && !mission_id) picked = modeMatch;
  }

  // ---- Path A: real contact → assemble + run engine on it. ----
  if (picked) {
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
      return res.status(500).json({ error: 'agent_failed' });
    }
  }

  // ---- Path B: no contact to draft on → synthesize a representative recipient.
  // Resolve the offer/audience/geo this draft is calibrated against:
  //   • standalone   → the typed sample (grounding = memory bank only).
  //   • per-mission  → the explicit mission (grounding = its bank + memory bank).
  //   • legacy       → the most-recent active mission for this voice's mode.
  let mission: MissionDoc | null = explicitMission;
  if (!standalone && !mission) {
    const missions = await scope.collection<MissionDoc>('missions').find({ archivedAt: null });
    missions.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    mission = missions[0] ?? null;
  }

  const mode = (persona.mode ?? mission?.mode ?? 'sales') as MissionMode;
  const goal = standalone ? (sample?.offer ?? '') : mission?.goal || '';
  const audience = standalone ? (sample?.audience ?? '') : mission?.targetDescription || '';
  const geo = standalone ? (sample?.geo ?? null) : mission?.geo ?? null;
  // The allowed-fact bank for this draft. Standalone ⇒ null (memory bank only);
  // otherwise this mission's substance + the memory bank.
  const groundingMissionId = standalone ? null : mission?._id ?? null;

  const run = await startRun(scope, { agentType: 'draft', missionId: mission?._id });
  try {
    const recipient = await synthesizeRecipient({ mode, goal, audience, geo });

    const profile = await scope.collection<ProfileDoc>('profiles').findOne();
    // Grounding (facts + exemplars) ranked against the offer. No real target ⇒ a
    // synthetic id yields no evidence bullets, just the memory bank (+ mission
    // facts when per-mission) - exactly the cold-start surface.
    const rankQuery = goal || audience || persona.name;
    const facts = await assembleAllowedFacts(scope, user.id, groundingMissionId, '__calibrate_synthetic__', rankQuery, {
      excludedFactIds: persona.excludedFactIds ?? [],
    });
    const exemplarDocs = await fetchExemplars(scope, user.id, persona._id, rankQuery);

    const ctx: AssembledContext = {
      mode,
      recipient: { name: recipient.name, role: recipient.role, company: recipient.company },
      sender: { name: profile?.name ?? null, role: profile?.role ?? null, organization: profile?.organization ?? null },
      missionGoal: goal || `Reach ${audience || 'a relevant contact'}`,
      audience: audience || recipient.role,
      whyNow: recipient.whyNow || undefined,
      allowedFacts: facts,
      exemplars: exemplarDocs.map((e) => ({ subject: e.subject, body: e.body })),
      styleProfile: persona.styleProfile ?? emptyStyleProfile(),
    };

    const result = await runDraftEngine(ctx, 'onboarding');

    await completeRun(scope, run._id, {
      persona_id: persona._id,
      persona_version: persona.styleProfileVersion ?? null,
      tier: 'onboarding',
      synthetic_recipient: true,
      pass: result.pass,
      revisions: result.revisions,
      voice_match_score: result.voiceMatchScore,
      violations: result.violations,
      violation_count: result.violations.length,
      fact_ids: facts.map((f) => f.id),
      exemplar_ids: exemplarDocs.map((e) => e.id),
      claims: result.draft.claims,
    });

    return res.status(200).json({
      run_id: run._id,
      recipient: { name: recipient.name, role: recipient.role, company: recipient.company },
      synthetic: true,
      subject: result.draft.subject,
      body: result.draft.body,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}

interface SynthRecipient {
  name: string;
  role: string;
  company: string;
  whyNow: string;
}

const RECIPIENT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    role: { type: 'string' },
    company: { type: 'string' },
    why_now: { type: 'string' },
  },
  required: ['name', 'role', 'company'],
} as const;

// Invent ONE realistic, representative recipient that matches the persona's
// ideal-contact profile, so the calibration draft reads like a real email. The
// person is illustrative (a stand-in until the user has real contacts), but the
// role/company/trigger must be plausible for this offer + audience.
async function synthesizeRecipient(args: {
  mode: MissionMode;
  goal: string;
  audience: string;
  geo: string | null;
}): Promise<SynthRecipient> {
  const icp = defaultContactIcp(args.mode, args.geo);
  const fallback: SynthRecipient = {
    name: 'Jordan Lee',
    role: icp.functions[0] ? `${titleCase(icp.functions[0])} Manager` : 'Operations Manager',
    company: 'Northwind Labs',
    whyNow: '',
  };

  const userPrompt = [
    `Mode: ${args.mode}`,
    args.goal ? `What's being sent / the offer: ${args.goal}` : '',
    args.audience ? `Who to reach (audience): ${args.audience}` : '',
    args.geo ? `Location focus: ${args.geo}` : '',
    `Target functions for this mode: ${icp.functions.slice(0, 6).join(', ')}`,
    `Seniority band: ${icp.seniority.idealLevels.join(', ')} (max ${icp.seniority.maxLevel})`,
    '',
    'Invent ONE realistic, representative recipient this person would actually email:',
    '- A plausible full name.',
    '- A role/title that fits the target functions and seniority band above.',
    '- A plausible (made-up) company that fits the audience.',
    '- A short, concrete "why now" trigger (a recent move, launch, hire, or signal) - one clause, no more.',
    'This is a stand-in example, not a real lead. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const { ok, data } = await generateJson<{ name?: string; role?: string; company?: string; why_now?: string }>({
      model: MODEL(),
      max_tokens: 512,
      temperature: 0.7,
      system:
        'You generate a single representative outreach recipient for a sales/BD/recruiting voice-calibration step. Keep it realistic and specific. Names and companies are illustrative stand-ins.',
      responseJsonSchema: RECIPIENT_SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!ok || !data) return fallback;
    return {
      name: (data.name ?? '').trim() || fallback.name,
      role: (data.role ?? '').trim() || fallback.role,
      company: (data.company ?? '').trim() || fallback.company,
      whyNow: (data.why_now ?? '').trim(),
    };
  } catch (err) {
    console.warn('synthesize_recipient_failed', err);
    return fallback;
  }
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
