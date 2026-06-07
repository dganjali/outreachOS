// Server-side pipeline orchestrator with SSE progress (flow.md §7).
//
// Reuses the existing agent handlers verbatim via an internal call shim — the
// agents stay 100% untouched (zero regression risk). The run is driven
// server-side and streams per-step progress to the client. Because the work
// runs on the server and each agent persists to the DB, the pipeline keeps
// going and completes even if the client disconnects (close the tab, reload
// the mission, and the results are there).

import type { Request, Response } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser } from '../_lib/db';
import type { MissionDoc, TargetDoc, ContactDoc } from '../../shared/schemas';

import agentTarget from './target';
import agentEvidence from './evidence';
import agentContacts from './contacts';
import agentSequence from './sequence';

const TOP_N = 5;
const TARGET_COUNT = 8;

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { mission_id } = (req.body ?? {}) as { mission_id?: string };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

  const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  // --- SSE setup ---
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  (res as unknown as { flushHeaders?: () => void }).flushHeaders?.();

  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
  });
  const send = (event: string, data: Record<string, unknown> = {}) => {
    if (clientGone) return; // stop writing, but the run keeps going server-side
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Drive an agent handler with a captured req/res so we reuse its exact logic
  // (auth, rate-limit, DB writes, telemetry) without touching the agent.
  async function call(h: Handler, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
    let status = 200;
    let data: any = null;
    const mreq = { method: 'POST', headers: req.headers, body } as unknown as Request;
    const mres = {
      setHeader() {
        return mres;
      },
      status(s: number) {
        status = s;
        return mres;
      },
      json(o: unknown) {
        data = o;
        return mres;
      },
      end() {
        return mres;
      },
    } as unknown as Response;
    await h(mreq, mres);
    return { status, data };
  }

  try {
    // 1) Targets — reuse existing if the mission already has them.
    send('phase', { phase: 'targeting' });
    let targets = await scope.collection<TargetDoc>('targets').find({ missionId: mission_id });
    if (targets.length === 0) {
      const r = await call(agentTarget, { mission_id, count: TARGET_COUNT });
      if (r.status === 429) {
        send('paused');
        return res.end();
      }
      if (r.status >= 400) {
        send('error', { message: r.data?.error ?? 'targeting_failed' });
        return res.end();
      }
      targets = (r.data?.targets ?? []) as TargetDoc[];
    }

    const top = targets
      .slice()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, TOP_N);

    if (top.length === 0) {
      send('done', { empty: true });
      return res.end();
    }

    send('targets', {
      targets: top.map((t) => ({ id: t._id, name: t.companyName, score: t.score ?? null })),
    });

    // 2) Per target: evidence -> contacts -> sequence.
    for (const t of top) {
      send('step', { targetId: t._id, step: 'evidence', status: 'running', note: `Researching ${t.companyName} — reading recent sources…` });
      const er = await call(agentEvidence, { target_id: t._id });
      if (er.status === 429) {
        send('paused');
        return res.end();
      }
      send('step', { targetId: t._id, step: 'evidence', status: er.status < 400 ? 'done' : 'failed' });
      if (er.status >= 400) continue;

      send('step', { targetId: t._id, step: 'contacts', status: 'running', note: `Finding the right decision-makers at ${t.companyName}…` });
      const cr = await call(agentContacts, { target_id: t._id });
      if (cr.status === 429) {
        send('paused');
        return res.end();
      }
      send('step', { targetId: t._id, step: 'contacts', status: cr.status < 400 ? 'done' : 'failed' });
      if (cr.status >= 400) continue;

      const contacts = (cr.data?.contacts ?? []) as ContactDoc[];
      const topContact = contacts.slice().sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      if (!topContact) {
        send('step', { targetId: t._id, step: 'sequence', status: 'failed' });
        continue;
      }

      send('step', { targetId: t._id, step: 'sequence', status: 'running', note: `Drafting a personalized email for ${t.companyName}…` });
      const sr = await call(agentSequence, { contact_id: topContact._id });
      if (sr.status === 429) {
        send('paused');
        return res.end();
      }
      send('step', { targetId: t._id, step: 'sequence', status: sr.status < 400 ? 'done' : 'failed' });
    }

    send('done');
    return res.end();
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : 'pipeline_failed' });
    return res.end();
  }
}
