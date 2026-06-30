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
import { forUser } from '../_lib/db';
import { generateJson, MODEL_PRO } from '../_lib/llm';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { buildSteerUpdates, isEmptyUpdate, normalizeProposal } from '../_lib/steer';
import type {
  CampaignPolicyDoc,
  ContextFactDoc,
  MissionDoc,
  SteerProposal,
} from '../../shared/schemas';

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
        sectors: { type: 'array', items: { type: 'string' } },
        draftDirective: { type: 'string' },
        draftDirectiveAppend: { type: 'string' },
        clearIcp: { type: 'boolean' },
      },
    },
    policy: {
      type: 'object',
      properties: {
        dailySendCap: { type: 'number' },
        minConfidence: { type: 'number' },
        cycleIntervalHours: { type: 'number' },
        targetsPerCycle: { type: 'number' },
        autoSend: { type: 'boolean' },
        timezone: { type: 'string' },
      },
    },
    emphasizeFactIds: { type: 'array', items: { type: 'string' } },
    deemphasizeFactIds: { type: 'array', items: { type: 'string' } },
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

const SYSTEM = `You are the steering controller for a cold-outreach autopilot. The user gives ONE instruction to adjust a running mission. Translate it into a structured patch over the mission's settings, in three areas:
- TARGETING (who it contacts): goal/offer, audience description (targetDescription), geo, sectors. For company-size or "bigger/smaller companies" asks, edit targetDescription to state the size preference and set mission.clearIcp=true so targeting regenerates. Targeting changes only affect the NEXT sourcing cycle, not already-found companies - say so in the summary.
- DRAFTING (how emails read): draftDirective (replace the standing instruction) or draftDirectiveAppend (add a line), and emphasizeFactIds / deemphasizeFactIds to pin or unpin specific facts. Resolve "this fact"/"that" to ids from the FACTS list; never invent an id.
- SENDING POLICY (autopilot pace + guardrails): dailySendCap, minConfidence (0-1), cycleIntervalHours, targetsPerCycle, autoSend, timezone.

Rules:
- Change ONLY what the instruction implies. Omit every field you are not changing. Do not restate unchanged settings.
- For every field you set, add a row to "changes" with a human label and the from/to values (stringified). "summary" is one plain sentence describing the net effect.
- If the instruction is ambiguous, unsupported, or you cannot map it to these fields, set "clarification" to a short question and leave the patch fields empty (still return an empty "changes" array).
- Output JSON only.`;

function settingsBlock(mission: MissionDoc, policy: CampaignPolicyDoc | null): string {
  const sectors = (mission.sectorSuggestions ?? []).map((s) => s.name).join(', ') || '(none set)';
  const pins = (mission.emphasizedFactIds ?? []).length;
  const lines = [
    'TARGETING',
    `- Goal / offer: ${mission.goal}`,
    `- Audience: ${mission.targetDescription}`,
    `- Geo: ${mission.geo ?? '(anywhere)'}`,
    `- Sectors: ${sectors}`,
    '',
    'DRAFTING',
    `- Standing directive: ${mission.draftDirective?.trim() || '(none)'}`,
    `- Pinned facts: ${pins} pinned`,
  ];
  if (policy) {
    lines.push(
      '',
      'SENDING POLICY',
      `- Auto-send: ${policy.autoSend ? 'on' : 'review first'}`,
      `- Daily send cap: ${policy.dailySendCap}`,
      `- Min confidence: ${policy.minConfidence}`,
      `- Cycle interval (hours): ${policy.cycleIntervalHours}`,
      `- Targets per cycle: ${policy.targetsPerCycle}`,
      `- Timezone: ${policy.timezone}`
    );
  }
  return lines.join('\n');
}

async function missionFacts(scope: ReturnType<typeof forUser>, missionId: string): Promise<ContextFactDoc[]> {
  return scope.collection<ContextFactDoc>('context_facts').find({
    $or: [{ scope: 'person' }, { scope: 'mission', missionId }],
  } as Record<string, unknown>);
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
  const policy = await scope.collection<CampaignPolicyDoc>('campaign_policies').findOne({ missionId: mission_id });
  const facts = await missionFacts(scope, mission_id);

  const run = await startRun(scope, { agentType: 'steer', missionId: mission_id, targetId: null, contactId: null });

  const factList = facts.length
    ? facts.map((f) => `[${f._id}] ${f.claim}`).join('\n')
    : '(no facts yet - cannot pin any)';
  const userPrompt = [
    `CURRENT SETTINGS\n${settingsBlock(mission, policy)}`,
    '',
    `FACTS you may pin/unpin (id -> claim):\n${factList}`,
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
  const policy = await scope.collection<CampaignPolicyDoc>('campaign_policies').findOne({ missionId: mission_id });

  // Only the user's own facts may be pinned.
  const facts = await missionFacts(scope, mission_id);
  const validFactIds = new Set(facts.map((f) => f._id));

  const { missionUpdate, policyUpdate } = buildSteerUpdates(mission, policy, proposal, { validFactIds });
  if (isEmptyUpdate({ missionUpdate, policyUpdate })) {
    return res.status(400).json({ error: 'nothing_to_apply' });
  }

  const run = await startRun(scope, { agentType: 'steer', missionId: mission_id, targetId: null, contactId: null });
  try {
    if (Object.keys(missionUpdate).length) {
      await scope.collection<MissionDoc>('missions').updateById(mission_id, missionUpdate);
    }
    if (policy && Object.keys(policyUpdate).length) {
      await scope.collection<CampaignPolicyDoc>('campaign_policies').updateById(policy._id, policyUpdate);
    }
    await completeRun(scope, run._id, {
      mission_fields: Object.keys(missionUpdate),
      policy_fields: Object.keys(policyUpdate),
    });
    return res.status(200).json({ ok: true, applied: proposal.changes ?? [] });
  } catch (err: unknown) {
    await failRun(scope, run._id, err instanceof Error ? err.message : 'unknown_error');
    return res.status(500).json({ error: 'apply_failed' });
  }
}
