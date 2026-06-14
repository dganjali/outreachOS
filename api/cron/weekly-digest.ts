// Weekly pipeline digest. Cloud Scheduler hits this weekly with the cron
// secret. For each user with Gmail connected, it computes the week's outreach
// stats and emails a short summary to the user's own address.

import type { Request, Response } from 'express';
import { adminDb, forUser } from '../_lib/db';
import { requireCronSecret } from '../_lib/auth';
import { getActiveAccessToken, sendNow } from '../_lib/gmail';
import type { UserIntegrationDoc, SentMessageDoc, ReplyDoc, EmailSequenceDoc, ProfileDoc } from '../../shared/schemas';

const WEEK = 7 * 24 * 60 * 60 * 1000;

export default async function handler(req: Request, res: Response) {
  if (!requireCronSecret(req, res)) return;

  const db = await adminDb();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - WEEK);
  const weekAhead = new Date(now.getTime() + WEEK);

  const users = await db
    .collection<UserIntegrationDoc>('user_integrations')
    .find({ provider: 'gmail', status: 'active' })
    .toArray();

  let emailed = 0;
  let skipped = 0;
  const errors: Array<{ user_id: string; error: string }> = [];

  for (const u of users) {
    const uid = u.userId;
    const scope = forUser(uid);
    try {
      const [sentThisWeek, repliesThisWeek, draftsPending, dueNext7] = await Promise.all([
        scope.collection<SentMessageDoc>('sent_messages').countDocuments({ status: 'sent', sentAt: { $gte: weekAgo } }),
        scope.collection<ReplyDoc>('replies').countDocuments({ receivedAt: { $gte: weekAgo } }),
        scope.collection<EmailSequenceDoc>('email_sequences').countDocuments({ status: 'draft' }),
        scope
          .collection<SentMessageDoc>('sent_messages')
          .countDocuments({ status: 'queued', scheduledSendAt: { $gt: now, $lte: weekAhead } }),
      ]);

      // Nothing happened and nothing's coming up - don't send a noise email.
      if (sentThisWeek === 0 && repliesThisWeek === 0 && draftsPending === 0 && dueNext7 === 0) {
        skipped++;
        continue;
      }

      const tok = await getActiveAccessToken(uid);
      if (!tok?.email) {
        skipped++;
        continue;
      }
      const prof = await scope.collection<ProfileDoc>('profiles').findOne();
      const replyRate = sentThisWeek > 0 ? Math.round((repliesThisWeek / sentThisWeek) * 100) : 0;
      const first = prof?.name ? prof.name.split(' ')[0] : 'there';

      const body = [
        `Hi ${first},`,
        '',
        `Your OutreachOS week:`,
        `  • ${sentThisWeek} email${sentThisWeek === 1 ? '' : 's'} sent`,
        `  • ${repliesThisWeek} repl${repliesThisWeek === 1 ? 'y' : 'ies'} (${replyRate}% reply rate)`,
        `  • ${draftsPending} draft${draftsPending === 1 ? '' : 's'} waiting for review`,
        `  • ${dueNext7} follow-up${dueNext7 === 1 ? '' : 's'} scheduled for the next 7 days`,
        '',
        draftsPending > 0 ? `Review your drafts: https://outreachos-495414.web.app/missions` : '',
        repliesThisWeek > 0 ? `Handle replies: https://outreachos-495414.web.app/inbox` : '',
        '',
        `- OutreachOS`,
      ]
        .filter((l) => l !== '')
        .join('\n');

      await sendNow({
        accessToken: tok.accessToken,
        fromEmail: tok.email,
        fromName: 'OutreachOS',
        toEmail: tok.email,
        subject: `Your outreach this week: ${sentThisWeek} sent, ${repliesThisWeek} replied`,
        body,
      });
      emailed++;
    } catch (err) {
      errors.push({ user_id: uid, error: err instanceof Error ? err.message : 'digest_failed' });
    }
  }

  return res.status(200).json({ users: users.length, emailed, skipped, errors });
}
