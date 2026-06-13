import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { getActiveAccessToken, sendNow, isValidEmailAddress } from '../_lib/gmail';
import { scheduleFollowups, isSuppressed } from '../_lib/sequencing';
import { recordOutcome } from '../_lib/outcomes';
import type {
  ContactDoc,
  EmailSequenceDoc,
  ProfileDoc,
  SentMessageDoc,
} from '../../shared/schemas';

interface SendBody {
  sequence_id?: string;
  touch_index?: number; // 0 = initial, 1+ = follow-ups
  mode?: 'draft' | 'send';
  to_override?: string;
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const body = (req.body ?? {}) as SendBody;
  const sequenceId = body.sequence_id;
  const touchIndex = body.touch_index ?? 0;
  const mode = body.mode ?? 'draft';
  if (!sequenceId) return res.status(400).json({ error: 'missing_sequence_id' });

  const seq = await scope
    .collection<EmailSequenceDoc & { profileRefs?: Record<string, Array<{ field: string; snippet: string }>> }>('email_sequences')
    .findById(sequenceId);
  if (!seq) return res.status(404).json({ error: 'sequence_not_found' });

  const contact = await scope.collection<ContactDoc>('contacts').findById(seq.contactId);
  if (!contact) return res.status(404).json({ error: 'contact_not_found' });

  const toEmail = body.to_override?.trim() || contact.email?.trim();
  if (!toEmail) {
    return res.status(400).json({ error: 'no_recipient_email', message: 'Contact has no email. Provide to_override.' });
  }
  // Reject header-injection / malformed recipients before building the message.
  if (!isValidEmailAddress(toEmail)) {
    return res.status(400).json({ error: 'invalid_recipient_email' });
  }

  // Suppression guard — never send (or draft) to a suppressed address.
  if (mode === 'send' && (await isSuppressed(scope, toEmail))) {
    return res.status(409).json({ error: 'suppressed', message: 'This address is on your suppression list.' });
  }

  // Pick the touch
  let subject: string;
  let bodyText: string;
  let priorMessageId: string | null = null;
  let threadId: string | null = null;

  if (touchIndex === 0) {
    subject = seq.subject;
    bodyText = seq.body;
  } else {
    const fu = seq.followups[touchIndex - 1];
    if (!fu) return res.status(400).json({ error: 'invalid_touch_index' });
    subject = fu.subject;
    bodyText = fu.body;

    const prior = await scope
      .collection<SentMessageDoc>('sent_messages')
      .findOne({ sequenceId, touchIndex: touchIndex - 1 });
    if (prior?.gmailMessageId) priorMessageId = `<${prior.gmailMessageId}>`;
    threadId = prior?.gmailThreadId ?? null;
  }

  const tok = await getActiveAccessToken(user.id);
  if (!tok) return res.status(412).json({ error: 'gmail_not_connected', message: 'Connect Gmail in Settings first.' });

  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  // Idempotency on (sequence_id, touch_index)
  const existing = await scope
    .collection<SentMessageDoc>('sent_messages')
    .findOne({ sequenceId, touchIndex });
  if (existing && existing.status === 'sent') {
    return res.status(409).json({ error: 'already_sent', sent_message_id: existing._id });
  }

  // Carry profile_version + per-touch refs from the source sequence.
  const refsByTouch = seq.profileRefs ?? {};
  const touchKey = touchIndex === 0 ? 'initial' : `followup_${touchIndex - 1}`;
  const touchRefs = Array.isArray(refsByTouch[touchKey]) ? refsByTouch[touchKey] : [];

  // Edit-delta capture: the AI's original draft for this touch vs the final text
  // being sent. For the initial email the original lives on the sequence; for
  // follow-ups we don't persist a separate original, so draft == final.
  const draftSubject = touchIndex === 0 ? seq.originalSubject ?? subject : subject;
  const draftBody = touchIndex === 0 ? seq.originalBody ?? bodyText : bodyText;

  const sentRowBase: Omit<InsertDoc<SentMessageDoc>, '_id'> = {
    sequenceId,
    contactId: contact._id,
    missionId: seq.missionId,
    touchIndex,
    subject,
    body: bodyText,
    draftSubject,
    draftBody,
    toEmail,
    gmailDraftId: null,
    gmailMessageId: null,
    gmailThreadId: null,
    status: 'queued',
    scheduledSendAt: null,
    sentAt: null,
    failedReason: null,
    profileVersionId: seq.profileVersionId ?? null,
    profileRefs: touchRefs,
  };

  let sentRowId: string;
  if (existing) {
    await scope.collection<SentMessageDoc>('sent_messages').updateById(existing._id, sentRowBase);
    sentRowId = existing._id;
  } else {
    const created = await scope
      .collection<SentMessageDoc>('sent_messages')
      .insertOne({ ...sentRowBase, _id: newId() } as InsertDoc<SentMessageDoc>);
    sentRowId = created._id;
  }

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

    // Drafts are kept in OutreachOS only — pushing them into the user's Gmail
    // would need the restricted gmail.compose scope. The user reviews the draft
    // here and clicks Send (gmail.send) when ready.
    let result: { messageId: string; threadId: string; draftId?: string };
    if (mode === 'send') {
      result = await sendNow(sendArgs);
    } else {
      result = { messageId: '', threadId: threadId ?? '' };
    }

    await scope.collection<SentMessageDoc>('sent_messages').updateById(sentRowId, {
      gmailDraftId: null,
      gmailMessageId: mode === 'send' ? result.messageId : null,
      gmailThreadId: mode === 'send' ? result.threadId : threadId ?? null,
      status: mode === 'send' ? 'sent' : 'draft',
      sentAt: mode === 'send' ? new Date() : null,
    });

    if (mode === 'send' && touchIndex === 0) {
      const sentAt = new Date();
      await scope.collection<EmailSequenceDoc>('email_sequences').updateById(sequenceId, {
        status: 'sent',
        sentAt,
      });
      await scope.collection<ContactDoc>('contacts').updateById(contact._id, { status: 'contacted' });

      // Credit the facts/exemplars behind this email with a 'sent' so per-fact
      // reply-rate has a denominator. Best-effort.
      await recordOutcome(user.id, contact._id, 'sent');

      // Auto-schedule the follow-up cadence unless the user paused it globally.
      const paused = (profile as ProfileDoc | null)?.pauseFollowups === true;
      if (!paused) {
        await scheduleFollowups({ scope, seq, toEmail, sentAt });
      }
    }

    return res.status(200).json({
      sent_message_id: sentRowId,
      mode,
      gmail_message_id: result.messageId,
      gmail_thread_id: result.threadId,
      gmail_draft_id: undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    await scope.collection<SentMessageDoc>('sent_messages').updateById(sentRowId, {
      status: 'failed',
      failedReason: msg,
    });
    return res.status(500).json({ error: 'send_failed', detail: msg });
  }
}
