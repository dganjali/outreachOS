// Server-side pipeline endpoints - the durable replacement for the browser
// orchestration in src/pages/MissionRun.tsx.
//
//   POST /api/agents/pipeline            { mission_id, count?, top_n?, top_contacts? } → starts a run
//   GET  /api/agents/pipeline?run_id=…   → current run state (self-heals stale runs)
//   GET  /api/agents/pipeline?mission_id=… → latest run for a mission (for reload)
//   POST /api/agents/pipeline/cancel     { run_id } → stop a run
//
// The client starts a run, then polls the GET endpoint. Progress survives a
// closed tab, a dropped connection, or an instance restart because the run doc
// is the source of truth and any poll re-drives a stalled run.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { startPipeline, resumeIfStale, cancelPipeline } from '../_lib/pipeline';
import { getOrCreateContactIcp } from './contacts';
import { buildContactTypeOptions } from '../_lib/icp';
import { getOrCreateSectors, buildSectorOptions } from '../_lib/sectors';
import type { MissionDoc, PipelineRunDoc } from '../../shared/schemas';
import type { MissionMode, SeniorityLevel } from '../../shared/types';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  if (req.method === 'POST') {
    const { mission_id, count, top_n, top_contacts, selected_functions, selected_seniority, selected_sectors } = (req.body ?? {}) as {
      mission_id?: string;
      count?: number;
      top_n?: number;
      top_contacts?: number;
      selected_functions?: string[];
      selected_seniority?: SeniorityLevel[];
      selected_sectors?: string[];
    };
    if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

    // Ownership: confirm the caller owns the mission before spending agent runs.
    const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
    if (!mission) return res.status(404).json({ error: 'mission_not_found' });

    // Don't start a second run while one is already live for this mission.
    const existing = await scope
      .collection<PipelineRunDoc>('pipeline_runs')
      .findOne({ missionId: mission_id, status: { $in: ['pending', 'running'] } as never });
    if (existing) {
      resumeIfStale(user, existing as PipelineRunDoc);
      return res.status(200).json({ data: serialize(existing as PipelineRunDoc), already_running: true });
    }

    const run = await startPipeline({
      user,
      missionId: mission_id,
      targetCount: count,
      topN: top_n,
      topContacts: top_contacts,
      selectedFunctions: selected_functions,
      selectedSeniority: selected_seniority,
      selectedSectors: selected_sectors,
    });
    return res.status(201).json({ data: serialize(run) });
  }

  if (req.method === 'GET') {
    const runId = req.query.run_id as string | undefined;
    const missionId = req.query.mission_id as string | undefined;

    // Generate the "types of people to reach out to" menu from the mission's ICP
    // so the client can let the user narrow WHO to contact before launching.
    if (req.query.contact_types) {
      if (!missionId) return res.status(400).json({ error: 'missing_mission_id' });
      const mission = await scope.collection<MissionDoc>('missions').findById(missionId);
      if (!mission) return res.status(404).json({ error: 'mission_not_found' });
      const mode = (mission.mode as MissionMode | null) ?? 'sales';
      const [icp, sectors] = await Promise.all([
        getOrCreateContactIcp(scope, mission, mode),
        getOrCreateSectors(scope, mission),
      ]);
      return res.status(200).json({ data: { ...buildContactTypeOptions(icp), sectors: buildSectorOptions(sectors) } });
    }

    let run: PipelineRunDoc | null = null;
    if (runId) {
      run = (await scope.collection<PipelineRunDoc>('pipeline_runs').findById(runId)) as PipelineRunDoc | null;
    } else if (missionId) {
      const rows = await scope
        .collection<PipelineRunDoc>('pipeline_runs')
        .find({ missionId } as never);
      run = latest(rows as PipelineRunDoc[]);
    } else {
      return res.status(400).json({ error: 'missing_run_id_or_mission_id' });
    }

    if (!run) return res.status(404).json({ error: 'run_not_found' });
    resumeIfStale(user, run);
    return res.status(200).json({ data: serialize(run) });
  }

  return methodNotAllowed(res, ['GET', 'POST']);
}

export async function cancel(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const { run_id } = (req.body ?? {}) as { run_id?: string };
  if (!run_id) return res.status(400).json({ error: 'missing_run_id' });
  const ok = await cancelPipeline(user, run_id);
  if (!ok) return res.status(404).json({ error: 'run_not_found' });
  return res.status(200).json({ ok: true });
}

function latest(rows: PipelineRunDoc[]): PipelineRunDoc | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
}

// Derive the in-flight step (cursor) so the client can render it as "running"
// without us persisting a transient status on every micro-step.
function serialize(run: PipelineRunDoc) {
  return {
    id: run._id,
    mission_id: run.missionId,
    status: run.status,
    phase: run.phase,
    note: run.note,
    error: run.error,
    config: run.config,
    cursor: run.cursor,
    targets: run.targets,
    started_at: run.startedAt,
    completed_at: run.completedAt,
  };
}
