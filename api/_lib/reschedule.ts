// Reschedule still-queued sends after a send-window / timezone change.
//
// The pure planning lives in autopilot.ts (planReschedule); this is just the
// I/O wrapper: load the mission's queued sends, compute their new send times,
// and persist the ones that moved. Shared by the reschedule endpoint and the
// steering-chat apply path so a window change reschedules either way.

import type { UserScope } from './db';
import { planReschedule } from './autopilot';
import type { CampaignPolicyDoc, SentMessageDoc } from '../../shared/schemas';

/** Recompute scheduledSendAt for the mission's queued sends. Returns how many moved. */
export async function rescheduleQueuedSends(
  scope: UserScope,
  missionId: string,
  policy: Pick<CampaignPolicyDoc, 'sendWindow' | 'timezone'>,
  now: Date = new Date(),
): Promise<number> {
  const sent = scope.collection<SentMessageDoc>('sent_messages');
  const queued = (await sent.find({ missionId, status: 'queued' } as never)) as SentMessageDoc[];
  if (queued.length === 0) return 0;

  const moves = planReschedule(
    queued.map((m) => ({ id: m._id, touchIndex: m.touchIndex, scheduledSendAt: m.scheduledSendAt })),
    policy,
    now,
  );
  for (const move of moves) {
    await sent.updateById(move.id, { scheduledSendAt: move.scheduledSendAt });
  }
  return moves.length;
}
