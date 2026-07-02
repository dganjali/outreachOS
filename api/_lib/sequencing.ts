// Follow-up scheduling + reply hygiene helpers.
//
// Follow-ups are not auto-sent inline. Sending the initial touch schedules the
// remaining touches as `sent_messages` rows with status='queued' and a future
// `scheduledSendAt`. The send-due-touches cron (Cloud Scheduler) sweeps those
// and sends each one, gated by suppression + reply-stop. No Cloud Tasks.

import { newId, type UserScope, type InsertDoc } from './db';
import { snapToWindow, type SendPolicy } from './autopilot';
import type { EmailSequenceDoc, SentMessageDoc, SuppressionDoc } from '../../shared/schemas';

const DEFAULT_WAIT_DAYS = 3;

function addDays(base: Date, days: number): Date {
  return new Date(base.getTime() + Math.max(0, days) * 24 * 60 * 60 * 1000);
}

/**
 * Queue the sequence's follow-up touches relative to when the initial was sent.
 * waitDays are cumulative (touch 1 after waitDays[0], touch 2 after another
 * waitDays[1], ...). Idempotent: skips a touchIndex that already exists.
 */
export async function scheduleFollowups(args: {
  scope: UserScope;
  seq: EmailSequenceDoc;
  toEmail: string;
  sentAt: Date;
  // The mission's send window/timezone (from the recipe), when it has one. Given
  // it, follow-ups land inside the window (time-of-day snapped); the cadence day
  // is preserved.
  policy?: Pick<SendPolicy, 'sendWindow' | 'timezone'> | null;
}): Promise<number> {
  const { scope, seq, toEmail, sentAt, policy } = args;
  const followups = seq.followups ?? [];
  if (followups.length === 0) return 0;

  const sent = scope.collection<SentMessageDoc>('sent_messages');
  let cumulative = 0;
  let scheduled = 0;

  for (let i = 0; i < followups.length; i++) {
    const fu = followups[i];
    // Advance the cadence clock first, so skipping a touch doesn't pull the
    // remaining follow-ups earlier - their send dates stay where they were.
    cumulative += typeof fu.waitDays === 'number' && fu.waitDays > 0 ? fu.waitDays : DEFAULT_WAIT_DAYS;
    const touchIndex = i + 1;

    // User opted this touch out of the sequence: never auto-queue it. touchIndex
    // stays positional (gmail/send reads followups[touchIndex - 1]).
    if (fu.disabled) continue;

    const exists = await sent.findOne({ sequenceId: seq._id, touchIndex });
    if (exists) continue;

    const row: Omit<InsertDoc<SentMessageDoc>, never> = {
      _id: newId(),
      sequenceId: seq._id,
      contactId: seq.contactId,
      missionId: seq.missionId,
      touchIndex,
      subject: fu.subject,
      body: fu.body,
      toEmail,
      gmailDraftId: null,
      gmailMessageId: null,
      gmailThreadId: null,
      status: 'queued',
      scheduledSendAt: policy ? snapToWindow(addDays(sentAt, cumulative), policy) : addDays(sentAt, cumulative),
      sentAt: null,
      failedReason: null,
      profileVersionId: seq.profileVersionId ?? null,
      profileRefs: [],
    } as InsertDoc<SentMessageDoc>;

    try {
      await sent.insertOne(row as InsertDoc<SentMessageDoc>);
      scheduled++;
    } catch {
      // unique (sequenceId, touchIndex) collision - already scheduled.
    }
  }
  return scheduled;
}

/** Cancel a contact's still-queued follow-ups (e.g. they replied or unsubscribed). */
export async function cancelQueuedForContact(
  scope: UserScope,
  contactId: string,
  reason: string
): Promise<number> {
  const sent = scope.collection<SentMessageDoc>('sent_messages');
  const queued = await sent.find({ contactId, status: 'queued' });
  for (const m of queued) {
    await sent.updateById(m._id, { status: 'failed', failedReason: reason });
  }
  return queued.length;
}

/**
 * Re-touch after a "not now". Reschedules the contact's earliest queued (or
 * recently-cancelled) follow-up to `days` out and drops the rest, so the user
 * gets exactly one timed nudge. Returns true if a re-touch was scheduled.
 */
export async function scheduleRetouch(
  scope: UserScope,
  contactId: string,
  days: number
): Promise<boolean> {
  const sent = scope.collection<SentMessageDoc>('sent_messages');
  // Prefer an existing follow-up row (queued or cancelled-by-reply) to reuse.
  const candidates = (await sent.find({ contactId }))
    .filter((m) => m.touchIndex > 0 && m.status !== 'sent')
    .sort((a, b) => a.touchIndex - b.touchIndex);
  if (candidates.length === 0) return false;

  const keep = candidates[0];
  await sent.updateById(keep._id, {
    status: 'queued',
    scheduledSendAt: addDays(new Date(), days),
    failedReason: null,
  });
  for (const m of candidates.slice(1)) {
    if (m.status === 'queued') await sent.updateById(m._id, { status: 'failed', failedReason: 'retouch_collapsed' });
  }
  return true;
}

export async function isSuppressed(scope: UserScope, email: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  if (!e) return false;
  const hit = await scope.collection<SuppressionDoc>('suppressions').findOne({ email: e });
  return !!hit;
}

export async function addSuppression(
  scope: UserScope,
  email: string,
  reason: SuppressionDoc['reason'],
  note: string | null = null
): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!e) return;
  try {
    await scope.collection<SuppressionDoc>('suppressions').insertOne({
      _id: newId(),
      email: e,
      reason,
      note,
    } as InsertDoc<SuppressionDoc>);
  } catch {
    // unique (userId, email) - already suppressed.
  }
}
