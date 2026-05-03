import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { TARGETING_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';

interface TargetSuggestion {
  company_name: string;
  domain: string | null;
  score: number;
  why_now: string;
  fit_reason: string;
  signal_type: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const { mission_id, count } = (req.body ?? {}) as { mission_id?: string; count?: number };
  if (!mission_id) return res.status(400).json({ error: 'missing_mission_id' });

  const db = adminClient();
  const { data: mission, error: mErr } = await db
    .from('missions')
    .select('*')
    .eq('id', mission_id)
    .eq('user_id', user.id)
    .single();
  if (mErr || !mission) return res.status(404).json({ error: 'mission_not_found' });

  const { data: profile } = await db
    .from('profiles')
    .select('name, role, organization, bio, proof_points')
    .eq('user_id', user.id)
    .single();

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'targeting',
    mission_id,
    input: { count: count ?? 10 },
  });

  const mode = (mission.mode as MissionMode | null) ?? 'sales';
  const userPrompt = [
    `Mission: ${mission.name}`,
    `Mode: ${mode}`,
    `What I'm sending / offer: ${mission.goal}`,
    `Target description (the why): ${mission.target_description}`,
    profile?.name ? `Sender: ${profile.name}${profile.role ? `, ${profile.role}` : ''}${profile.organization ? ` at ${profile.organization}` : ''}` : '',
    profile?.proof_points ? `Sender credibility: ${profile.proof_points}` : '',
    '',
    `Find ${count ?? 10} target organizations with strong recent "why now" signals. Use web_search.`,
    'Return JSON only, no commentary.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const message = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: 4096,
      system: TARGETING_SYSTEM,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<{ targets: TargetSuggestion[] }>(message);
    if (!parsed.ok || !parsed.data?.targets) {
      await failRun(db, run.id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const rows = parsed.data.targets.slice(0, 25).map((t) => ({
      mission_id,
      company_name: t.company_name,
      domain: t.domain,
      score: clamp(t.score, 0, 100),
      why_now: t.why_now,
      fit_reason: t.fit_reason,
      signal_type: t.signal_type,
      status: 'suggested',
    }));

    const { data: inserted, error: insErr } = await db
      .from('targets')
      .insert(rows)
      .select('*');
    if (insErr) {
      await failRun(db, run.id, insErr.message);
      return res.status(500).json({ error: 'insert_failed', detail: insErr.message });
    }

    await completeRun(db, run.id, { count: inserted?.length ?? 0 });
    return res.status(200).json({ run_id: run.id, targets: inserted });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

function clamp(n: number, lo: number, hi: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
