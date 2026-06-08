// Follow-up sweeper. Cloud Scheduler hits this every ~15 min with the cron
// secret. It finds queued follow-up touches whose scheduledSendAt has passed
// and sends each one, gated by: user pause, sequence/contact already replied,
// suppression, and Gmail connectivity.

import type { Request, Response } from 'express';
import { adminDb, forUser } from '../_lib/db';
import { requireCronSecret } from '../_lib/auth';
import { getActiveAccessToken, sendNow } from '../_lib/gmail';
import { isSuppressed } from '../_lib/sequencing';
import type {
  SentMessageDoc,
  EmailSequenceDoc,
  ContactDoc,
  ProfileDoc,
} from '../../shared/schemas';

const BATCH = 200;

export default async function handler(req: Request, res: Response) {
  if (!requireCronSecret(req, res)) return;

  const db = await adminDb();
  const now = new Date();
  const due = await db
    .collection<SentMessageDoc>('sent_messages')
    .find({ status: 'queued', scheduledSendAt: { $gt: new Date(0), $lte: now } })
    .sort({ scheduledSendAt: 1 })
    .limit(BATCH)
    .toArray();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ id: string; error: string }> = [];

  // Cache per-user pause + token so we don't refetch for every touch.
  const pauseCache = new Map<string, boolean>();
  const tokenCache = new Map<string, { accessToken: string; email: string | null } | null>();

  for (const msg of due) {
    const uid = (msg as SentMessageDoc & { userId: string }).userId;
    const scope = forUser(uid);
    const sentCol = scope.collection<SentMessageDoc>('sent_messages');

    const cancel = async (reason: string) => {
      await sentCol.updateById(msg._id, { status: 'failed', failedReason: reason });
      skipped++;
    };

    try {
      // User paused follow-ups?
      if (!pauseCache.has(uid)) {
        const prof = await scope.collection<ProfileDoc>('profiles').findOne();
        pauseCache.set(uid, prof?.pauseFollowups === true);
      }
      if (pauseCache.get(uid)) {
        skipped++;
        continue; // leave queued; resume when they unpause
      }

      // Sequence still active?
      const seq = await scope.collection<EmailSequenceDoc>('email_sequences').findById(msg.sequenceId);
      if (!seq || ['replied', 'bounced', 'archived'].includes(seq.status)) {
        await cancel('sequence_inactive');
        continue;
      }

      // Contact already replied?
      const contact = await scope.collection<ContactDoc>('contacts').findById(msg.contactId);
      if (!contact || contact.status === 'replied') {
        await cancel('contact_replied');
        continue;
      }

      // Suppressed?
      if (await isSuppressed(scope, msg.toEmail)) {
        await cancel('suppressed');
        continue;
      }

      // Gmail connected?
      if (!tokenCache.has(uid)) {
        const tok = await getActiveAccessToken(uid);
        tokenCache.set(uid, tok ? { accessToken: tok.accessToken, email: tok.email ?? null } : null);
      }
      const tok = tokenCache.get(uid);
      if (!tok) {
        await cancel('gmail_not_connected');
        continue;
      }

      // Thread the reply onto the previous touch.
      const prior = await sentCol.findOne({ sequenceId: msg.sequenceId, touchIndex: msg.touchIndex - 1, status: 'sent' });
      const prof = await scope.collection<ProfileDoc>('profiles').findOne();

      const result = await sendNow({
        accessToken: tok.accessToken,
        fromEmail: tok.email ?? '',
        fromName: prof?.name ?? undefined,
        toEmail: msg.toEmail,
        subject: msg.subject,
        body: msg.body,
        threadId: prior?.gmailThreadId ?? undefined,
        inReplyTo: prior?.gmailMessageId ? `<${prior.gmailMessageId}>` : undefined,
      });

      await sentCol.updateById(msg._id, {
        status: 'sent',
        sentAt: new Date(),
        gmailMessageId: result.messageId,
        gmailThreadId: result.threadId,
      });
      sent++;
    } catch (err) {
      failed++;
      const detail = err instanceof Error ? err.message : 'send_failed';
      errors.push({ id: msg._id, error: detail });
      try {
        await sentCol.updateById(msg._id, { status: 'failed', failedReason: detail });
      } catch {
        /* ignore */
      }
    }
  }

  return res.status(200).json({ due: due.length, sent, skipped, failed, errors });
}
