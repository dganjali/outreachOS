import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { getActiveAccessToken, sendNow, isValidEmailAddress, type MailAttachment } from '../_lib/gmail';
import { getResumeAttachment, hasResume } from '../_lib/attachments';
import { scheduleFollowups, isSuppressed } from '../_lib/sequencing';
import { evaluateSend } from '../_lib/deliverability';
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
  scheduled_send_at?: string; // ISO 8601 - queue for the cron instead of sending now
  attach_resume?: boolean; // attach the sender's résumé to this touch
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
  const attachResume = body.attach_resume === true;
  if (!sequenceId) return res.status(400).json({ error: 'missing_sequence_id' });

  // Scheduled send: queue the touch for the send-due-touches cron instead of
  // sending inline. Only valid for an immediate-style request (not a draft) and
  // must be a real future timestamp.
  let scheduledSendAt: Date | null = null;
  if (body.scheduled_send_at) {
    const when = new Date(body.scheduled_send_at);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid_scheduled_send_at' });
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: 'scheduled_send_at_in_past' });
    scheduledSendAt = when;
  }

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

  // Suppression guard - never send (or draft) to a suppressed address.
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

  // Résumé attachment. Validate up-front (immediate AND scheduled) so the user
  // learns now if they asked to attach but have none on file. The bytes are only
  // loaded for an immediate send; a scheduled send persists the intent and the
  // cron re-loads the résumé at actual send time.
  let resumeAttachment: MailAttachment | null = null;
  if (attachResume) {
    if (mode === 'send' && !scheduledSendAt) {
      try {
        resumeAttachment = await getResumeAttachment(scope);
      } catch {
        return res.status(400).json({ error: 'resume_unreadable', message: 'Could not read your résumé file. Re-upload it in your profile.' });
      }
      if (!resumeAttachment) {
        return res.status(400).json({ error: 'no_resume_on_file', message: 'No résumé on file. Upload one in your profile first.' });
      }
    } else if (!(await hasResume(scope))) {
      return res.status(400).json({ error: 'no_resume_on_file', message: 'No résumé on file. Upload one in your profile first.' });
    }
  }

  // Deliverability gate for real, immediate sends (scheduled sends are gated by
  // the send-due-touches cron at actual send time). Blocks spam/abuse/over-cap;
  // soft warnings ride back on the success response for the UI to show.
  let sendWarnings: string[] = [];
  if (mode === 'send' && !scheduledSendAt) {
    const verdict = await evaluateSend(scope, {
      toEmail,
      subject,
      body: bodyText,
      moderationCache: seq.moderation ?? null,
    });
    if (verdict.moderationToPersist) {
      await scope
        .collection<EmailSequenceDoc>('email_sequences')
        .updateById(sequenceId, { moderation: verdict.moderationToPersist });
    }
    if (verdict.blocked) {
      return res.status(422).json({ error: verdict.blockCode ?? 'blocked', message: verdict.blockReason });
    }
    sendWarnings = verdict.warnings;
  }

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
    scheduledSendAt,
    sentAt: null,
    failedReason: null,
    profileVersionId: seq.profileVersionId ?? null,
    profileRefs: touchRefs,
    attachResume,
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

  // Queue-only path: the row is now persisted with status 'queued' and a future
  // scheduledSendAt. The send-due-touches cron picks it up and does the actual
  // send (plus follow-up scheduling for the initial touch). Don't hit Gmail now.
  if (scheduledSendAt) {
    return res.status(200).json({
      sent_message_id: sentRowId,
      mode: 'scheduled',
      scheduled_send_at: scheduledSendAt.toISOString(),
    });
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
      attachments: resumeAttachment ? [resumeAttachment] : undefined,
    };

    // Drafts are kept in OutreachOS only - pushing them into the user's Gmail
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

      // Auto-schedule the follow-up cadence ONLY when the user opted in. Off by
      // default: without reply visibility (send-only scope) auto follow-ups would
      // keep nudging people who already replied. A global pause also suppresses it.
      const prof = profile as ProfileDoc | null;
      const autoFollowups = prof?.autoFollowups === true && prof?.pauseFollowups !== true;
      if (autoFollowups) {
        await scheduleFollowups({ scope, seq, toEmail, sentAt });
      }
    }

    return res.status(200).json({
      sent_message_id: sentRowId,
      mode,
      gmail_message_id: result.messageId,
      gmail_thread_id: result.threadId,
      gmail_draft_id: undefined,
      warnings: sendWarnings,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'send_failed';
    await scope.collection<SentMessageDoc>('sent_messages').updateById(sentRowId, {
      status: 'failed',
      failedReason: msg,
    });
    return res.status(500).json({ error: 'send_failed' });
  }
}
