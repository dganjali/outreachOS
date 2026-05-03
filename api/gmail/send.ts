import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { getActiveAccessToken, createDraft, sendNow } from '../_lib/gmail';

interface SendBody {
  sequence_id?: string;
  touch_index?: number; // 0 = initial, 1+ = follow-ups
  mode?: 'draft' | 'send';
  to_override?: string; // for cases where contact.email is empty
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const body = (req.body ?? {}) as SendBody;
  const sequenceId = body.sequence_id;
  const touchIndex = body.touch_index ?? 0;
  const mode = body.mode ?? 'draft';
  if (!sequenceId) return res.status(400).json({ error: 'missing_sequence_id' });

  const db = adminClient();

  const { data: seq, error: sErr } = await db
    .from('email_sequences')
    .select('*, contacts!inner(*), missions!inner(user_id)')
    .eq('id', sequenceId)
    .eq('missions.user_id', user.id)
    .single();
  if (sErr || !seq) return res.status(404).json({ error: 'sequence_not_found' });

  const contact = seq.contacts as { id: string; email: string | null; name: string };
  const toEmail = body.to_override?.trim() || contact.email?.trim();
  if (!toEmail) return res.status(400).json({ error: 'no_recipient_email', message: 'Contact has no email. Provide to_override.' });

  // Pick the touch
  let subject: string;
  let bodyText: string;
  let priorMessageId: string | null = null;
  let threadId: string | null = null;

  if (touchIndex === 0) {
    subject = seq.subject;
    bodyText = seq.body;
  } else {
    const fu = (seq.followups as Array<{ subject: string; body: string }>)[touchIndex - 1];
    if (!fu) return res.status(400).json({ error: 'invalid_touch_index' });
    subject = fu.subject;
    bodyText = fu.body;

    // Look up the prior touch in sent_messages so we can thread the reply
    const { data: prior } = await db
      .from('sent_messages')
      .select('gmail_message_id, gmail_thread_id')
      .eq('sequence_id', sequenceId)
      .eq('touch_index', touchIndex - 1)
      .maybeSingle();
    if (prior?.gmail_message_id) priorMessageId = `<${prior.gmail_message_id}>`;
    threadId = prior?.gmail_thread_id ?? null;
  }

  const tok = await getActiveAccessToken(user.id);
  if (!tok) return res.status(412).json({ error: 'gmail_not_connected', message: 'Connect Gmail in Settings first.' });

  const { data: profile } = await db
    .from('profiles')
    .select('name')
    .eq('user_id', user.id)
    .single();

  // Insert sent_messages row first (idempotent on (sequence_id, touch_index))
  const { data: existing } = await db
    .from('sent_messages')
    .select('id, status')
    .eq('sequence_id', sequenceId)
    .eq('touch_index', touchIndex)
    .maybeSingle();
  if (existing && existing.status === 'sent') {
    return res.status(409).json({ error: 'already_sent', sent_message_id: existing.id });
  }

  const insertPayload = {
    user_id: user.id,
    sequence_id: sequenceId,
    contact_id: contact.id,
    mission_id: seq.mission_id as string,
    touch_index: touchIndex,
    subject,
    body: bodyText,
    to_email: toEmail,
    status: 'queued' as const,
  };

  const upsertRes = existing
    ? await db.from('sent_messages').update(insertPayload).eq('id', existing.id).select('*').single()
    : await db.from('sent_messages').insert(insertPayload).select('*').single();
  if (upsertRes.error) return res.status(500).json({ error: 'db_insert_failed', detail: upsertRes.error.message });
  const sentRow = upsertRes.data;

  try {
    const sendArgs = {
      accessToken: tok.accessToken,
      fromEmail: tok.email ?? user.email ?? '',
      fromName: profile?.name ?? undefined,
      toEmail,
      subject,
      body: bodyText,
      threadId: threadId ?? undefined,
      inReplyTo: priorMessageId ?? undefined,
    };

    let result: { messageId: string; threadId: string; draftId?: string };
    if (mode === 'send') {
      const r = await sendNow(sendArgs);
      result = r;
    } else {
      const r = await createDraft(sendArgs);
      result = r;
    }

    await db
      .from('sent_messages')
      .update({
        gmail_draft_id: mode === 'draft' ? (result as { draftId?: string }).draftId : null,
        gmail_message_id: result.messageId,
        gmail_thread_id: result.threadId,
        status: mode === 'send' ? 'sent' : 'draft',
        sent_at: mode === 'send' ? new Date().toISOString() : null,
      })
      .eq('id', sentRow.id);

    if (mode === 'send' && touchIndex === 0) {
      // Mark sequence + contact as contacted
      await db.from('email_sequences').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', sequenceId);
      await db.from('contacts').update({ status: 'contacted' }).eq('id', contact.id);
    }

    return res.status(200).json({
      sent_message_id: sentRow.id,
      mode,
      gmail_message_id: result.messageId,
      gmail_thread_id: result.threadId,
      gmail_draft_id: mode === 'draft' ? (result as { draftId?: string }).draftId : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    await db
      .from('sent_messages')
      .update({ status: 'failed', failed_reason: msg })
      .eq('id', sentRow.id);
    return res.status(500).json({ error: 'send_failed', detail: msg });
  }
}
