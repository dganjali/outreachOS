// Steer agent - the autopilot steering chat.
//
// Two endpoints:
//   - default (POST /api/agents/steer): INTERPRET. Turns one natural-language
//     instruction ("go for bigger companies", "emphasize this fact") into a
//     structured SteerProposal over the mission's targeting / drafting / sending
//     settings. Does NOT write anything - the user reviews first.
//   - apply  (POST /api/agents/steer/apply): COMMIT. Re-validates the proposal
//     server-side (clamps numerics, drops unowned fact ids via buildSteerUpdates)
//     and writes the mission + campaign_policy.
//
// Mirrors the refine agent's shape (generateJson + run logging).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId } from '../_lib/db';
import { generateJson, MODEL_PRO } from '../_lib/llm';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { buildSteerUpdates, isEmptyUpdate, normalizeProposal } from '../_lib/steer';
import { resolveRecipe, applyRecipePatch, upsertRecipe, policyView, type RecipeStages } from '../_lib/recipe';
import { rescheduleQueuedSends } from '../_lib/reschedule';
import type {
  ContextFactDoc,
  MissionDoc,
  SteerProposal,
  TargetDoc,
} from '../../shared/schemas';

// Cap how many targets we surface to the agent (prompt budget) + how many a
// single instruction may add (bounds cost/abuse).
const MAX_TARGETS_IN_PROMPT = 40;
const MAX_TARGETS_ADD = 10;

interface SteerOut extends SteerProposal {
  summary: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    clarification: { type: 'string' },
    mission: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        targetDescription: { type: 'string' },
        geo: { type: 'string' },
        draftDirective: { type: 'string' },
        draftDirectiveAppend: { type: 'string' },
        clearIcp: { type: 'boolean' },
      },
    },
    recipe: {
      type: 'object',
      properties: {
        automationEnabled: { type: 'boolean' },
        sourcing: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            count: { type: 'number' },
            topN: { type: 'number' },
            sectors: { type: 'array', items: { type: 'string' } },
          },
        },
        verification: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            emailVerify: { type: 'boolean' },
            contactVerify: { type: 'boolean' },
            minConfidence: { type: 'number' },
          },
        },
        research: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            evidence: { type: 'boolean' },
            companyEnrich: { type: 'boolean' },
          },
        },
        personSourcing: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            contactsPerCompany: { type: 'number' },
            functions: { type: 'array', items: { type: 'string' } },
            seniority: { type: 'array', items: { type: 'string' } },
          },
        },
        sequencing: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, touches: { type: 'number' } },
        },
        send: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            autoSend: { type: 'boolean' },
            dailySendCap: { type: 'number' },
            cycleIntervalHours: { type: 'number' },
            timezone: { type: 'string' },
            sendWindow: {
              type: 'object',
              properties: { startHour: { type: 'number' }, endHour: { type: 'number' } },
            },
          },
        },
      },
    },
    emphasizeFactIds: { type: 'array', items: { type: 'string' } },
    deemphasizeFactIds: { type: 'array', items: { type: 'string' } },
    targets: {
      type: 'object',
      properties: {
        add: { type: 'array', items: { type: 'string' } },
        removeIds: { type: 'array', items: { type: 'string' } },
        pinIds: { type: 'array', items: { type: 'string' } },
      },
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } },
        required: ['label', 'from', 'to'],
      },
    },
  },
  required: ['summary', 'changes'],
} as const;

const SYSTEM = `You are the steering controller for a cold-outreach autopilot. The user gives ONE instruction to adjust a running mission. The mission runs a modular pipeline (a "recipe") whose every stage you can edit. Translate the instruction into a structured patch.

MISSION brief (targeting intent):
- goal/offer, audience description (targetDescription), geo. For company-size or "bigger/smaller companies" asks, edit targetDescription to state the size preference and set mission.clearIcp=true so targeting regenerates. Brief/recipe.sourcing changes only affect the NEXT sourcing cycle, not already-found companies - say so in the summary.
- draftDirective (replace the standing drafting instruction) or draftDirectiveAppend (add a line); emphasizeFactIds / deemphasizeFactIds to pin/unpin specific facts (resolve "this fact"/"that" to ids from the FACTS list; never invent an id).

TARGETS (the specific companies/people already discovered), via targets.*:
- targets.add: names to add as new targets ("also reach out to Acme and Globex").
- targets.removeIds: target ids to drop ("drop that one", "remove Acme) - resolve to ids from the TARGETS list; never invent an id.
- targets.pinIds: target ids to keep and pursue for sure. Only touch targets when the instruction is about specific companies/people; leave empty otherwise.

RECIPE stages (recipe.*):
- sourcing: enabled, count (companies/people to discover per run), topN (how many to actually pursue), sectors (sector bias).
- verification: enabled, emailVerify, contactVerify, minConfidence (0-1 auto-send confidence floor).
- research: enabled, evidence, companyEnrich.
- personSourcing: enabled, contactsPerCompany (how many people per company), functions (e.g. "sales","engineering"), seniority (one or more of: ic, senior_ic, lead, manager, senior_manager, director, senior_director, vp, svp, cxo, founder). Use this for "find more people per company" (set contactsPerCompany) or "target the VP of Sales not the CEO" (set functions + seniority).
- sequencing: enabled, touches (total emails in the sequence, initial + follow-ups).
- send: enabled, autoSend, dailySendCap, cycleIntervalHours, timezone, sendWindow {startHour,endHour}.
- automationEnabled: the autopilot master switch.

Rules:
- Change ONLY what the instruction implies. Omit every stage/field you are not changing. Do not restate unchanged settings.
- For every field you set, add a row to "changes" with a human label and the from/to values (stringified). "summary" is one plain sentence describing the net effect.
- If the instruction is ambiguous, unsupported, or you cannot map it to these fields, set "clarification" to a short question and leave the patch fields empty (still return an empty "changes" array).
- Output JSON only.`;

function settingsBlock(mission: MissionDoc, recipe: RecipeStages): string {
  const pins = (mission.emphasizedFactIds ?? []).length;
  const s = recipe.sourcing;
  const v = recipe.verification;
  const r = recipe.research;
  const ps = recipe.personSourcing;
  const send = recipe.send;
  const list = (a: string[]) => (a.length ? a.join(', ') : '(any)');
  return [
    'MISSION BRIEF',
    `- Goal / offer: ${mission.goal}`,
    `- Audience: ${mission.targetDescription}`,
    `- Geo: ${mission.geo ?? '(anywhere)'}`,
    `- Standing directive: ${mission.draftDirective?.trim() || '(none)'}`,
    `- Pinned facts: ${pins} pinned`,
    '',
    'RECIPE',
    `- Automation: ${recipe.automationEnabled ? 'on' : 'off'}`,
    `- Sourcing: ${s.enabled ? 'on' : 'off'}, discover ${s.count}, pursue ${s.topN}; sectors ${list(s.sectors)}`,
    `- Verification: ${v.enabled ? 'on' : 'off'}, emailVerify ${v.emailVerify}, contactVerify ${v.contactVerify}, minConfidence ${v.minConfidence}`,
    `- Research: ${r.enabled ? 'on' : 'off'}, evidence ${r.evidence}, companyEnrich ${r.companyEnrich}`,
    `- Person sourcing: ${ps.enabled ? 'on' : 'off'}, ${ps.contactsPerCompany} per company; functions ${list(ps.functions)}; seniority ${list(ps.seniority)}`,
    `- Sequencing: ${recipe.sequencing.enabled ? 'on' : 'off'}, ${recipe.sequencing.touches} touches`,
    `- Send: ${send.enabled ? 'on' : 'off'}, autoSend ${send.autoSend}, cap ${send.dailySendCap}/day, every ${send.cycleIntervalHours}h, window ${send.sendWindow.startHour}-${send.sendWindow.endHour} ${send.timezone}`,
  ].join('\n');
}

async function missionFacts(scope: ReturnType<typeof forUser>, missionId: string): Promise<ContextFactDoc[]> {
  return scope.collection<ContextFactDoc>('context_facts').find({
    $or: [{ scope: 'person' }, { scope: 'mission', missionId }],
  } as Record<string, unknown>);
}

// The live targets the agent may edit: exclude rejected ones (already dropped).
async function missionTargets(scope: ReturnType<typeof forUser>, missionId: string): Promise<TargetDoc[]> {
  const all = (await scope.collection<TargetDoc>('targets').find({ missionId } as Record<string, unknown>)) as TargetDoc[];
  return all.filter((t) => t.status !== 'rejected').slice(0, MAX_TARGETS_IN_PROMPT);
}

// Apply the proposal's direct target edits. Best-effort per op so one bad id
// never aborts the rest. Returns a tally for the run log.
export async function applyTargetOps(
  scope: ReturnType<typeof forUser>,
  missionId: string,
  ops: NonNullable<SteerProposal['targets']>,
  validIds: Set<string>,
): Promise<{ added: number; removed: number; pinned: number }> {
  const tally = { added: 0, removed: 0, pinned: 0 };
  for (const id of ops.removeIds ?? []) {
    if (!validIds.has(id)) continue;
    try {
      await scope.collection<TargetDoc>('targets').updateById(id, { status: 'rejected' } as Partial<TargetDoc>);
      tally.removed++;
    } catch (err) {
      console.warn('steer target remove failed', id, err);
    }
  }
  for (const id of ops.pinIds ?? []) {
    if (!validIds.has(id)) continue;
    try {
      await scope.collection<TargetDoc>('targets').updateById(id, { status: 'approved' } as Partial<TargetDoc>);
      tally.pinned++;
    } catch (err) {
      console.warn('steer target pin failed', id, err);
    }
  }
  const names = [...new Set((ops.add ?? []).map((n) => n.trim()).filter(Boolean))].slice(0, MAX_TARGETS_ADD);
  for (const companyName of names) {
    try {
      await scope.collection<TargetDoc>('targets').insertOne({
        _id: newId(),
        missionId,
        companyName,
        domain: null,
        score: null,
        whyNow: null,
        fitReason: null,
        signalType: null,
        status: 'suggested',
        source: 'manual',
        industry: null,
        employeeCount: null,
        headquartersLocation: null,
      } as never);
      tally.added++;
    } catch (err) {
      console.warn('steer target add failed', companyName, err);
    }
  }
  return tally;
}

export function hasTargetOps(ops: SteerProposal['targets'] | undefined): boolean {
  return !!ops && ((ops.add?.length ?? 0) > 0 || (ops.removeIds?.length ?? 0) > 0 || (ops.pinIds?.length ?? 0) > 0);
}

// --- INTERPRET ------------------------------------------------------------

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { mission_id, instruction } = (req.body ?? {}) as { mission_id?: string; instruction?: string };
  if (!mission_id || !instruction?.trim()) return res.status(400).json({ error: 'missing_mission_or_instruction' });

  const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });
  const recipe = await resolveRecipe(scope, mission_id);
  const facts = await missionFacts(scope, mission_id);
  const targets = await missionTargets(scope, mission_id);

  const run = await startRun(scope, { agentType: 'steer', missionId: mission_id, targetId: null, contactId: null });

  const factList = facts.length
    ? facts.map((f) => `[${f._id}] ${f.claim}`).join('\n')
    : '(no facts yet - cannot pin any)';
  const targetList = targets.length
    ? targets.map((t) => `[${t._id}] ${t.seedContact?.name ?? t.companyName} (${t.status})`).join('\n')
    : '(no targets discovered yet)';
  const userPrompt = [
    `CURRENT SETTINGS\n${settingsBlock(mission, recipe)}`,
    '',
    `FACTS you may pin/unpin (id -> claim):\n${factList}`,
    '',
    `TARGETS you may remove/pin (id -> name):\n${targetList}`,
    '',
    `INSTRUCTION: ${instruction.trim()}`,
    'Output JSON only.',
  ].join('\n');

  try {
    const r = await generateJson<SteerOut>({
      model: MODEL_PRO(),
      max_tokens: 1536,
      temperature: 0.3, // mostly deterministic mapping
      system: SYSTEM,
      responseJsonSchema: SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!r.ok || !r.data) {
      await failRun(scope, run._id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: r.raw.slice(0, 500) });
    }
    const { summary, ...proposal } = r.data;
    proposal.changes = Array.isArray(proposal.changes) ? proposal.changes : [];
    await completeRun(scope, run._id, { instruction, has_clarification: !!proposal.clarification });
    return res.status(200).json({ run_id: run._id, summary: summary ?? '', proposal });
  } catch (err: unknown) {
    await failRun(scope, run._id, err instanceof Error ? err.message : 'unknown_error');
    return res.status(500).json({ error: 'agent_failed' });
  }
}

// --- APPLY ----------------------------------------------------------------

export async function apply(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { mission_id, proposal: rawProposal } = (req.body ?? {}) as { mission_id?: string; proposal?: unknown };
  if (!mission_id || !rawProposal) return res.status(400).json({ error: 'missing_mission_or_proposal' });
  // The proposal round-trips through the frontend data shim, which snake_cases
  // nested keys; normalize back to camelCase so buildSteerUpdates sees the fields.
  const proposal = normalizeProposal(rawProposal);

  const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });
  const current = await resolveRecipe(scope, mission_id);

  // Only the user's own facts may be pinned.
  const facts = await missionFacts(scope, mission_id);
  const validFactIds = new Set(facts.map((f) => f._id));

  const { missionUpdate, recipePatch } = buildSteerUpdates(mission, proposal, { validFactIds });
  const targetOps = proposal.targets;
  if (isEmptyUpdate({ missionUpdate, recipePatch }) && !hasTargetOps(targetOps)) {
    return res.status(400).json({ error: 'nothing_to_apply' });
  }
  // Merge + clamp the recipe patch onto the current recipe (server-side safety).
  const nextStages = applyRecipePatch(current, recipePatch);
  const recipeChanged = !isEmptyUpdate({ missionUpdate: {}, recipePatch });

  const run = await startRun(scope, { agentType: 'steer', missionId: mission_id, targetId: null, contactId: null });
  try {
    if (Object.keys(missionUpdate).length) {
      await scope.collection<MissionDoc>('missions').updateById(mission_id, missionUpdate);
    }
    if (recipeChanged) {
      await upsertRecipe(scope, mission_id, nextStages);
      // A window/timezone change must move already-queued sends into the new
      // window, same as the cockpit's schedule editor does.
      if (recipePatch.send?.sendWindow || recipePatch.send?.timezone) {
        await rescheduleQueuedSends(scope, mission_id, policyView(nextStages), new Date());
      }
    }
    let targetTally = { added: 0, removed: 0, pinned: 0 };
    if (hasTargetOps(targetOps)) {
      // Only the user's own live targets may be removed/pinned.
      const valid = new Set((await missionTargets(scope, mission_id)).map((t) => t._id));
      targetTally = await applyTargetOps(scope, mission_id, targetOps!, valid);
    }
    await completeRun(scope, run._id, {
      mission_fields: Object.keys(missionUpdate),
      recipe_changed: recipeChanged,
      targets: targetTally,
    });
    return res.status(200).json({ ok: true, applied: proposal.changes ?? [] });
  } catch (err: unknown) {
    await failRun(scope, run._id, err instanceof Error ? err.message : 'unknown_error');
    return res.status(500).json({ error: 'apply_failed' });
  }
}
