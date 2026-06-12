// Autopilot policy management — the per-mission policy the user configures.
//
//   GET  /api/agents/autopilot?mission_id=…  → the policy (defaults if none yet)
//   POST /api/agents/autopilot               { mission_id, ...patch } → upsert
//
// The cron driver (api/cron/autopilot.ts) acts on these policies.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId } from '../_lib/db';
import { defaultPolicyFields, sanitizePolicyPatch } from '../_lib/autopilot';
import type { AutopilotPolicyDoc, MissionDoc } from '../../shared/schemas';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const missionId =
    req.method === 'GET'
      ? (req.query.mission_id as string | undefined)
      : ((req.body ?? {}) as { mission_id?: string }).mission_id;
  if (!missionId) return res.status(400).json({ error: 'missing_mission_id' });

  // Ownership: the policy is only reachable through a mission the caller owns.
  const mission = await scope.collection<MissionDoc>('missions').findById(missionId);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  const col = scope.collection<AutopilotPolicyDoc>('autopilot_policies');
  let policy = await col.findOne({ missionId } as never);

  if (req.method === 'GET') {
    if (!policy) {
      // Return defaults without persisting — the row is created on first save.
      return res.status(200).json({ data: serialize({ ...defaultPolicyFields(), missionId } as AutopilotPolicyDoc, missionId) });
    }
    return res.status(200).json({ data: serialize(policy, missionId) });
  }

  if (req.method === 'POST') {
    const patch = sanitizePolicyPatch((req.body ?? {}) as Record<string, unknown>);
    if (!policy) {
      policy = await col.insertOne({
        _id: newId(),
        missionId,
        ...defaultPolicyFields(),
        ...patch,
      } as never);
    } else {
      await col.updateById(policy._id, patch);
      policy = { ...policy, ...patch };
    }
    return res.status(200).json({ data: serialize(policy, missionId) });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}

function serialize(p: AutopilotPolicyDoc, missionId: string) {
  return {
    mission_id: missionId,
    enabled: p.enabled,
    targets_per_week: p.targetsPerWeek,
    auto_send: p.autoSend,
    max_sends_per_day: p.maxSendsPerDay,
    send_window_start_hour: p.sendWindowStartHour,
    send_window_end_hour: p.sendWindowEndHour,
    send_days: p.sendDays,
    min_contact_confidence: p.minContactConfidence,
    require_verified_email: p.requireVerifiedEmail,
    last_discovery_at: p.lastDiscoveryAt ?? null,
    last_sweep_at: p.lastSweepAt ?? null,
  };
}
