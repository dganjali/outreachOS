import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { EVIDENCE_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';

interface EvidenceBullet {
  fact: string;
  source_url: string;
  source_title: string;
  signal_type: string;
  recency: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const { target_id } = (req.body ?? {}) as { target_id?: string };
  if (!target_id) return res.status(400).json({ error: 'missing_target_id' });

  const db = adminClient();
  const { data: target, error: tErr } = await db
    .from('targets')
    .select('*, missions!inner(*)')
    .eq('id', target_id)
    .eq('missions.user_id', user.id)
    .single();
  if (tErr || !target) return res.status(404).json({ error: 'target_not_found' });

  const mission = target.missions as { id: string; mode: MissionMode | null; goal: string };

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'evidence',
    mission_id: mission.id,
    target_id,
  });

  const userPrompt = [
    `Target: ${target.company_name}${target.domain ? ` (${target.domain})` : ''}`,
    `Mode: ${mission.mode ?? 'sales'}`,
    `Sender's offer: ${mission.goal}`,
    target.why_now ? `Existing why-now hint: ${target.why_now}` : '',
    '',
    'Build a 4-6 bullet evidence pack with sources. Use web_search. JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const message = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: 3072,
      system: EVIDENCE_SYSTEM,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<{ bullets: EvidenceBullet[] }>(message);
    if (!parsed.ok || !parsed.data?.bullets) {
      await failRun(db, run.id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const bullets = parsed.data.bullets.slice(0, 8);

    const { data: pack, error: insErr } = await db
      .from('evidence_packs')
      .insert({
        target_id,
        bullets,
        citations: parsed.citations,
      })
      .select('*')
      .single();
    if (insErr) {
      await failRun(db, run.id, insErr.message);
      return res.status(500).json({ error: 'insert_failed', detail: insErr.message });
    }

    await completeRun(db, run.id, { evidence_pack_id: pack.id, count: bullets.length });
    return res.status(200).json({ run_id: run.id, evidence_pack: pack });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
