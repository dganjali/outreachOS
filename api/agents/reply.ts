import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { createMessageWithRetry, MODEL, extractJson } from '../_lib/anthropic';
import { REPLY_ROUTER_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';

interface ReplyClassification {
  classification: string;
  urgency: 'low' | 'normal' | 'high';
  key_points: string[];
  suggested_response: { subject: string; body: string } | null;
  recommended_action: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  if (!await checkRateLimit(adminClient(), res, user.id)) return;

  const { reply_id } = (req.body ?? {}) as { reply_id?: string };
  if (!reply_id) return res.status(400).json({ error: 'missing_reply_id' });

  const db = adminClient();
  const { data: reply, error: rErr } = await db
    .from('replies')
    .select('*')
    .eq('id', reply_id)
    .eq('user_id', user.id)
    .single();
  if (rErr || !reply) return res.status(404).json({ error: 'reply_not_found' });

  // Load the prior sent message + sequence + contact + mission for context
  const { data: sent } = reply.sent_message_id
    ? await db
        .from('sent_messages')
        .select('*, email_sequences!inner(*, contacts!inner(*), missions!inner(*))')
        .eq('id', reply.sent_message_id)
        .single()
    : { data: null };

  const sequence = sent?.email_sequences;
  const contact = sequence?.contacts;
  const mission = sequence?.missions;

  const { data: profile } = await db
    .from('profiles')
    .select('name, role, organization, writing_tone')
    .eq('user_id', user.id)
    .single();

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'reply',
    mission_id: mission?.id ?? null,
    contact_id: contact?.id ?? null,
  });

  const userPrompt = [
    'ORIGINAL OUTREACH (what we sent)',
    sent ? `Subject: ${sent.subject}\n\n${sent.body}` : '(unknown — could not match thread)',
    '',
    'REPLY (what they sent back)',
    `From: ${reply.from_email ?? '(unknown)'}`,
    `Subject: ${reply.subject ?? ''}`,
    '',
    reply.body || reply.snippet || '(empty body)',
    '',
    'CONTEXT',
    contact ? `Recipient: ${contact.name} (${contact.role})` : '',
    mission ? `Mission goal: ${mission.goal}` : '',
    profile?.name ? `Sender: ${profile.name}${profile.role ? `, ${profile.role}` : ''}` : '',
    profile?.writing_tone ? `Sender tone: ${profile.writing_tone}` : '',
    '',
    'Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 1024,
      system: REPLY_ROUTER_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<ReplyClassification>(message);
    if (!parsed.ok || !parsed.data) {
      await failRun(db, run.id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const cls = parsed.data;
    await db
      .from('replies')
      .update({
        classification: cls.classification,
        urgency: cls.urgency,
        key_points: cls.key_points,
        suggested_response: cls.suggested_response,
        recommended_action: cls.recommended_action,
      })
      .eq('id', reply_id);

    if (contact && (cls.classification === 'unsubscribe' || cls.classification === 'not_now')) {
      // Stop the sequence — no more follow-ups
      await db
        .from('sent_messages')
        .update({ status: 'failed', failed_reason: `suppressed_${cls.classification}` })
        .eq('contact_id', contact.id)
        .eq('status', 'queued');
    }
    if (contact) {
      await db.from('contacts').update({ status: 'replied' }).eq('id', contact.id);
    }

    await completeRun(db, run.id, { classification: cls.classification });
    return res.status(200).json({ run_id: run.id, classification: cls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
