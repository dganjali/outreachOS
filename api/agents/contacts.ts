import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { CONTACTS_SYSTEM, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';

interface ContactSuggestion {
  name: string;
  role: string;
  linkedin_url: string | null;
  email: string | null;
  likely_email_pattern: string | null;
  confidence: number;
  reasoning: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  if (!await checkRateLimit(adminClient(), res, user.id)) return;

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

  const mission = target.missions as { id: string; name: string; goal: string; mode: MissionMode | null; target_description: string };

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'contacts',
    mission_id: mission.id,
    target_id,
  });

  const mode = mission.mode ?? 'sales';
  const userPrompt = [
    `Target organization: ${target.company_name}${target.domain ? ` (${target.domain})` : ''}`,
    `Mission mode: ${mode}`,
    `What's being offered: ${mission.goal}`,
    `Why this target: ${target.fit_reason ?? mission.target_description}`,
    target.why_now ? `Why now: ${target.why_now}` : '',
    '',
    'Find the 2-4 best people to contact. Use web_search on company site, LinkedIn public pages, press, blog. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const message = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: 2048,
      system: CONTACTS_SYSTEM,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<{ contacts: ContactSuggestion[] }>(message);
    if (!parsed.ok || !parsed.data?.contacts) {
      await failRun(db, run.id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const rows = parsed.data.contacts.slice(0, 6).map((c) => ({
      target_id,
      name: c.name,
      role: c.role,
      email: c.email ?? '',
      linkedin_url: c.linkedin_url,
      likely_email_pattern: c.likely_email_pattern,
      confidence: clamp01(c.confidence),
      reasoning: c.reasoning,
      status: 'suggested',
    }));

    const { data: inserted, error: insErr } = await db
      .from('contacts')
      .insert(rows)
      .select('*');
    if (insErr) {
      await failRun(db, run.id, insErr.message);
      return res.status(500).json({ error: 'insert_failed', detail: insErr.message });
    }

    await completeRun(db, run.id, { count: inserted?.length ?? 0 });
    return res.status(200).json({ run_id: run.id, contacts: inserted });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

function clamp01(n: number) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
