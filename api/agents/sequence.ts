import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { anthropic, MODEL, extractJson } from '../_lib/anthropic';
import { sequenceSystem, type MissionMode } from '../_lib/prompts';
import { startRun, completeRun, failRun } from '../_lib/runs';

interface SequenceOutput {
  primary_angle: string;
  anchored_bullets: number[];
  initial: { subject: string; body: string };
  followups: Array<{ wait_days: number; subject: string; body: string }>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const { contact_id } = (req.body ?? {}) as { contact_id?: string };
  if (!contact_id) return res.status(400).json({ error: 'missing_contact_id' });

  const db = adminClient();
  const { data: contact, error: cErr } = await db
    .from('contacts')
    .select('*, targets!inner(*, missions!inner(*))')
    .eq('id', contact_id)
    .eq('targets.missions.user_id', user.id)
    .single();
  if (cErr || !contact) return res.status(404).json({ error: 'contact_not_found' });

  const target = contact.targets as { id: string; company_name: string; domain: string | null; why_now: string | null; fit_reason: string | null; missions: { id: string; name: string; goal: string; target_description: string; mode: MissionMode | null } };
  const mission = target.missions;

  const { data: profile } = await db
    .from('profiles')
    .select('name, role, organization, bio, proof_points, achievements, metrics, writing_tone, example_emails')
    .eq('user_id', user.id)
    .single();

  const { data: latestPack } = await db
    .from('evidence_packs')
    .select('*')
    .eq('target_id', target.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const bullets = (latestPack?.bullets as Array<{ fact: string; source_title?: string; source_url?: string; recency?: string }>) ?? [];
  if (bullets.length === 0) {
    return res.status(409).json({ error: 'no_evidence_pack', message: 'Generate an evidence pack first.' });
  }

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'sequence',
    mission_id: mission.id,
    target_id: target.id,
    contact_id,
  });

  const mode = mission.mode ?? 'sales';
  const evidenceText = bullets
    .map((b, i) => `[${i}] ${b.fact} — ${b.source_title ?? ''} (${b.recency ?? ''})`)
    .join('\n');

  const senderBlock = profile
    ? [
        `Name: ${profile.name ?? 'Unknown'}`,
        profile.role ? `Role: ${profile.role}` : '',
        profile.organization ? `Org: ${profile.organization}` : '',
        profile.proof_points ? `Proof points: ${profile.proof_points}` : '',
        profile.metrics ? `Metrics: ${profile.metrics}` : '',
        profile.writing_tone ? `Preferred tone: ${profile.writing_tone}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : 'No sender profile provided.';

  const userPrompt = [
    `RECIPIENT`,
    `Name: ${contact.name}`,
    `Role: ${contact.role}`,
    `Company: ${target.company_name}`,
    '',
    `MISSION`,
    `Goal / what's being offered: ${mission.goal}`,
    `Audience description: ${mission.target_description}`,
    target.why_now ? `Why now (target): ${target.why_now}` : '',
    '',
    `EVIDENCE PACK (use indices in anchored_bullets)`,
    evidenceText,
    '',
    `SENDER PROFILE`,
    senderBlock,
    profile?.example_emails ? `\nSENDER EXAMPLE EMAILS (style reference, do not copy)\n${profile.example_emails}` : '',
    '',
    'Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const message = await anthropic().messages.create({
      model: MODEL(),
      max_tokens: 2048,
      system: sequenceSystem(mode),
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<SequenceOutput>(message);
    if (!parsed.ok || !parsed.data?.initial) {
      await failRun(db, run.id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const seq = parsed.data;
    const { data: row, error: insErr } = await db
      .from('email_sequences')
      .insert({
        contact_id,
        target_id: target.id,
        mission_id: mission.id,
        evidence_pack_id: latestPack?.id ?? null,
        primary_angle: seq.primary_angle,
        anchored_bullets: seq.anchored_bullets ?? [],
        subject: seq.initial.subject,
        body: seq.initial.body,
        followups: seq.followups ?? [],
        status: 'draft',
      })
      .select('*')
      .single();
    if (insErr) {
      await failRun(db, run.id, insErr.message);
      return res.status(500).json({ error: 'insert_failed', detail: insErr.message });
    }

    await completeRun(db, run.id, { sequence_id: row.id });
    return res.status(200).json({ run_id: run.id, sequence: row });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
