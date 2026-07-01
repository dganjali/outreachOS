// Campaign Autopilot sweeper. Cloud Scheduler hits this ~hourly with the cron
// secret. For each enabled, paid-tier policy it:
//   1. Sources fresh targets on a cadence (a background pipeline run that drafts
//      but never sends), and nudges any stale live run forward.
//   2. Applies the confidence gate to fresh drafts → 'review' (held) or, when the
//      address is verified + confident, 'ready' (await approval) / queued.
//   3. When autoSend is on, queues passing drafts as scheduled sends within the
//      daily cap + send window. The existing send-due-touches cron then sends
//      them and schedules the follow-up cadence.
//
// Everything heavy (the actual send, follow-up scheduling) is delegated to the
// send-due-touches cron; this handler only decides + queues, so it stays fast.

import type { Request, Response } from 'express';
import { adminDb, forUser, newId, type InsertDoc } from '../_lib/db';
import { requireCronSecret } from '../_lib/auth';
import { evaluateSend } from '../_lib/deliverability';
import { startPipeline, resumeIfStale, DEFAULT_TARGET_COUNT } from '../_lib/pipeline';
import {
  gateDecision,
  nextSendSlots,
  remainingCapToday,
  bumpedCounter,
  sourcingDue,
  withPolicyDefaults,
} from '../_lib/autopilot';
import { isPaidPlan } from '../../shared/plans';
import { recordContacted } from '../_lib/contacted';
import type {
  CampaignPolicyDoc,
  ContactDoc,
  EmailSequenceDoc,
  PipelineRunDoc,
  ProfileDoc,
  SentMessageDoc,
} from '../../shared/schemas';

// Bound work per tick so one big mission can't make the handler run long.
const MAX_POLICIES = 200;
const MAX_DRAFTS_PER_POLICY = 60;

interface PolicyOutcome {
  policyId: string;
  sourced: boolean;
  gated: number;
  queued: number;
  reviewed: number;
  ready: number;
  skipped?: string;
}

export default async function handler(req: Request, res: Response) {
  if (!requireCronSecret(req, res)) return;

  const db = await adminDb();
  const now = new Date();
  const policies = await db
    .collection<CampaignPolicyDoc>('campaign_policies')
    .find({ enabled: true })
    .limit(MAX_POLICIES)
    .toArray();

  const outcomes: PolicyOutcome[] = [];

  for (const raw of policies) {
    // Normalize so missing/legacy fields read as sane defaults regardless of how
    // the policy was written (the UI may persist a partial doc).
    const policy: CampaignPolicyDoc = { ...raw, ...withPolicyDefaults(raw) };
    const uid = policy.userId;
    const scope = forUser(uid);
    const out: PolicyOutcome = { policyId: policy._id, sourced: false, gated: 0, queued: 0, reviewed: 0, ready: 0 };
    try {
      // 1. Plan gate (authoritative - the UI also hides the toggle for free).
      const profile = await scope.collection<ProfileDoc>('profiles').findOne();
      if (!isPaidPlan(profile?.plan, profile?.planStatus)) {
        out.skipped = 'not_paid';
        outcomes.push(out);
        continue;
      }

      // 2. Sourcing: nudge any stale live run, else start one on cadence.
      const liveRuns = (await scope
        .collection<PipelineRunDoc>('pipeline_runs')
        .find({ missionId: policy.missionId, status: { $in: ['pending', 'running'] } as never })) as PipelineRunDoc[];
      if (liveRuns.length > 0) {
        for (const r of liveRuns) resumeIfStale({ id: uid, email: null }, r);
      } else if (sourcingDue(policy, now)) {
        await startSourcing(scope, uid, policy);
        await scope.collection<CampaignPolicyDoc>('campaign_policies').updateById(policy._id, { lastSourcedAt: now });
        out.sourced = true;
      }

      // 3. Gate fresh drafts (status 'draft' with no autopilot verdict yet).
      const drafts = ((await scope
        .collection<EmailSequenceDoc>('email_sequences')
        .find({ missionId: policy.missionId, status: 'draft' })) as EmailSequenceDoc[])
        .filter((s) => !s.autopilotState)
        .slice(0, MAX_DRAFTS_PER_POLICY);

      const passing: Array<{ seq: EmailSequenceDoc; contact: ContactDoc }> = [];
      for (const seq of drafts) {
        const contact = await scope.collection<ContactDoc>('contacts').findById(seq.contactId);
        if (!contact) continue;
        out.gated++;
        const toEmail = contact.email?.trim();
        // Autopilot eligibility (verified email + confidence). Fail → human review.
        if (!toEmail || gateDecision(contact, policy) === 'review') {
          await setState(scope, seq._id, 'review');
          out.reviewed++;
          continue;
        }
        // Deliverability content gate: spam lint + abuse moderation + suppression.
        // Autopilot only auto-sends CLEAN drafts; anything flagged goes to review.
        // A cap block isn't a content problem - it just means "send later", so it
        // doesn't downgrade the draft.
        const verdict = await evaluateSend(scope, {
          toEmail,
          subject: seq.subject,
          body: seq.body,
          moderationCache: seq.moderation ?? null,
          now,
        });
        if (verdict.moderationToPersist) {
          await scope
            .collection<EmailSequenceDoc>('email_sequences')
            .updateById(seq._id, { moderation: verdict.moderationToPersist });
        }
        const contentBlocked =
          verdict.blocked && verdict.blockCode !== 'account_daily_cap' && verdict.blockCode !== 'domain_daily_cap';
        if (contentBlocked || verdict.warnings.length > 0) {
          await setState(scope, seq._id, 'review');
          out.reviewed++;
          continue;
        }
        if (!policy.autoSend) {
          await setState(scope, seq._id, 'ready');
          out.ready++;
          continue;
        }
        passing.push({ seq, contact });
      }

      // 4. Auto-send: queue scheduled sends within the daily cap + send window.
      if (policy.autoSend && passing.length > 0) {
        const cap = remainingCapToday(policy, now);
        const queueable: Array<{ seq: EmailSequenceDoc; toEmail: string; contact: ContactDoc }> = [];
        for (const { seq, contact } of passing) {
          if (queueable.length >= cap) break;
          const toEmail = contact.email?.trim();
          if (!toEmail) {
            await setState(scope, seq._id, 'review');
            out.reviewed++;
            continue;
          }
          // Skip one already sent/queued for THIS sequence (idempotent).
          const existing = await scope
            .collection<SentMessageDoc>('sent_messages')
            .findOne({ sequenceId: seq._id, touchIndex: 0 });
          if (existing) {
            await setState(scope, seq._id, 'queued');
            continue;
          }
          // Recipient-level dedup: never queue a second initial email to an
          // address already contacted (sent or queued) under this mission, even
          // when re-sourcing routed it through a fresh contact/sequence.
          const contacted = await scope
            .collection<SentMessageDoc>('sent_messages')
            .findOne({
              missionId: seq.missionId,
              toEmail,
              touchIndex: 0,
              status: { $in: ['queued', 'sent'] } as never,
            });
          if (contacted) {
            await setState(scope, seq._id, 'queued');
            continue;
          }
          queueable.push({ seq, toEmail, contact });
        }

        const slots = nextSendSlots(policy, queueable.length, now);
        for (let i = 0; i < queueable.length; i++) {
          const { seq, toEmail, contact } = queueable[i];
          await queueSend(scope, seq, toEmail, slots[i]);
          await setState(scope, seq._id, 'queued');
          // Record the global "already contacted" ledger + cross-account heat the
          // moment we commit the initial touch, so no future mission re-emails them.
          await recordContacted(scope, {
            email: toEmail,
            linkedinUrl: contact.linkedinUrl,
            name: contact.name,
            missionId: seq.missionId,
          });
          out.queued++;
        }
        if (out.queued > 0) {
          await scope
            .collection<CampaignPolicyDoc>('campaign_policies')
            .updateById(policy._id, { counter: bumpedCounter(policy, now, out.queued) });
        }
      }
    } catch (err) {
      out.skipped = err instanceof Error ? err.message : 'policy_failed';
    }
    outcomes.push(out);
  }

  return res.status(200).json({ policies: policies.length, outcomes });
}

/** Kick off a background sourcing run, reusing the mission's last run config.
 *  Exported so the manual "cycle now" endpoint (api/agents/autopilot-run.ts)
 *  sources on the same path as the cron. */
export async function startSourcing(scope: ReturnType<typeof forUser>, uid: string, policy: CampaignPolicyDoc): Promise<void> {
  const prior = ((await scope
    .collection<PipelineRunDoc>('pipeline_runs')
    .find({ missionId: policy.missionId })) as PipelineRunDoc[])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  const cfg = prior?.config;
  await startPipeline({
    user: { id: uid, email: null },
    missionId: policy.missionId,
    targetCount: Math.max(policy.targetsPerCycle, cfg?.targetCount ?? DEFAULT_TARGET_COUNT),
    topN: policy.targetsPerCycle,
    topContacts: cfg?.topContacts,
    selectedFunctions: cfg?.selectedFunctions,
    selectedSeniority: cfg?.selectedSeniority,
    selectedSectors: cfg?.selectedSectors,
  });
}

async function setState(
  scope: ReturnType<typeof forUser>,
  seqId: string,
  state: EmailSequenceDoc['autopilotState'],
): Promise<void> {
  await scope.collection<EmailSequenceDoc>('email_sequences').updateById(seqId, { autopilotState: state });
}

/** Insert a queued initial-touch send row - same shape as gmail/send.ts's
 *  scheduled path - so send-due-touches sends it and schedules follow-ups. */
async function queueSend(
  scope: ReturnType<typeof forUser>,
  seq: EmailSequenceDoc,
  toEmail: string,
  scheduledSendAt: Date,
): Promise<void> {
  const row: Omit<InsertDoc<SentMessageDoc>, '_id'> = {
    sequenceId: seq._id,
    contactId: seq.contactId,
    missionId: seq.missionId,
    touchIndex: 0,
    subject: seq.subject,
    body: seq.body,
    draftSubject: seq.originalSubject ?? seq.subject,
    draftBody: seq.originalBody ?? seq.body,
    toEmail,
    gmailDraftId: null,
    gmailMessageId: null,
    gmailThreadId: null,
    status: 'queued',
    scheduledSendAt,
    sentAt: null,
    failedReason: null,
    profileVersionId: seq.profileVersionId ?? null,
    profileRefs: [],
  };
  await scope.collection<SentMessageDoc>('sent_messages').insertOne({ ...row, _id: newId() } as InsertDoc<SentMessageDoc>);
}
