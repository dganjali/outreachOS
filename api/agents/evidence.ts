// Evidence pack agent. Now also embeds the bullets so they're retrievable
// via Atlas Vector Search downstream.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { MODEL, WEB_SEARCH_TOOL, generateJsonWithSearch } from '../_lib/llm';
import { EVIDENCE_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { embedOne } from '../_lib/embeddings';
import type { EvidencePackDoc, MissionDoc, TargetDoc } from '../../shared/schemas';

interface EvidenceBullet {
  fact: string;
  source_url: string;
  source_title: string;
  signal_type: string;
  recency: string;
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { target_id } = (req.body ?? {}) as { target_id?: string };
  if (!target_id) return res.status(400).json({ error: 'missing_target_id' });

  const target = await scope.collection<TargetDoc>('targets').findById(target_id);
  if (!target) return res.status(404).json({ error: 'target_not_found' });
  const mission = await scope.collection<MissionDoc>('missions').findById(target.missionId);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  const run = await startRun(scope, {
    agentType: 'evidence',
    missionId: mission._id,
    targetId: target_id,
  });

  const userPrompt = [
    `Target: ${target.companyName}${target.domain ? ` (${target.domain})` : ''}`,
    `Mode: ${mission.mode ?? 'sales'}`,
    `Sender's offer: ${mission.goal}`,
    target.whyNow ? `Existing why-now hint: ${target.whyNow}` : '',
    '',
    'Build a 4-6 bullet evidence pack with sources. Use web_search. JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const parsed = await generateJsonWithSearch<{ bullets: EvidenceBullet[] }>({
      model: MODEL(),
      max_tokens: 3072,
      system: EVIDENCE_SYSTEM,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!parsed.ok || !parsed.data?.bullets) {
      await failRun(scope, run._id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const bullets = parsed.data.bullets.slice(0, 8).map((b) => ({
      fact: b.fact,
      sourceUrl: b.source_url,
      sourceTitle: b.source_title,
      signalType: b.signal_type,
      recency: b.recency,
    }));

    const pack = await scope.collection<EvidencePackDoc>('evidence_packs').insertOne({
      _id: newId(),
      targetId: target_id,
      missionId: mission._id,
      bullets,
      citations: parsed.citations,
    } as InsertDoc<EvidencePackDoc>);

    // Embed off the critical path - the vector only feeds downstream Atlas Vector
    // Search, so don't make the caller (pipeline driver) wait on it. Best-effort.
    void (async () => {
      try {
        const txt = bullets.map((b) => b.fact).join('\n');
        const embedding = await embedOne(txt, 'document');
        await scope.collection<EvidencePackDoc>('evidence_packs').updateById(pack._id, { embedding } as Partial<EvidencePackDoc>);
      } catch (err) {
        console.warn('embed_evidence_failed', err);
      }
    })();

    await completeRun(scope, run._id, { evidence_pack_id: pack._id, count: bullets.length });
    return res.status(200).json({ run_id: run._id, evidence_pack: pack });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}
