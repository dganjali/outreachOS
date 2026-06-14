// Send a reply to an inbound message, in-thread, via the user's Gmail.
// Powers the Inbox "Send reply" button (the suggested response, editable).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { getActiveAccessToken, sendNow, isValidEmailAddress } from '../_lib/gmail';
import type { ProfileDoc, ReplyDoc } from '../../shared/schemas';

interface ReplyBody {
  reply_id?: string;
  subject?: string;
  body?: string;
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { reply_id, subject, body } = (req.body ?? {}) as ReplyBody;
  if (!reply_id || !body?.trim()) return res.status(400).json({ error: 'missing_params' });

  const reply = await scope.collection<ReplyDoc>('replies').findById(reply_id);
  if (!reply) return res.status(404).json({ error: 'reply_not_found' });

  const toEmail = reply.fromEmail?.trim();
  if (!toEmail) return res.status(400).json({ error: 'no_recipient', message: 'This reply has no sender address to reply to.' });
  if (!isValidEmailAddress(toEmail)) return res.status(400).json({ error: 'invalid_recipient_email' });

  const tok = await getActiveAccessToken(user.id);
  if (!tok) return res.status(412).json({ error: 'gmail_not_connected', message: 'Connect Gmail in Settings first.' });

  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  // Keep the subject in-thread ("Re: …") unless the client supplied one.
  const original = reply.subject ?? '';
  const finalSubject =
    subject?.trim() || (/^re:/i.test(original) ? original : `Re: ${original}`.trim());

  try {
    const result = await sendNow({
      accessToken: tok.accessToken,
      fromEmail: tok.email ?? user.email ?? '',
      fromName: profile?.name ?? undefined,
      toEmail,
      subject: finalSubject,
      body,
      threadId: reply.gmailThreadId ?? undefined,
      inReplyTo: reply.gmailMessageId ? `<${reply.gmailMessageId}>` : undefined,
    });

    // Replying resolves the thread - mark it handled.
    await scope.collection<ReplyDoc>('replies').updateById(reply_id, { handled: true });

    return res.status(200).json({
      ok: true,
      gmail_message_id: result.messageId,
      gmail_thread_id: result.threadId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    return res.status(500).json({ error: 'send_failed', detail: msg });
  }
}
