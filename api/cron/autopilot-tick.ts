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
import { startPipeline, resumeIfStale } from '../_lib/pipeline';
import {
  gateDecision,
  nextSendSlots,
  remainingCapToday,
  bumpedCounter,
  sourcingDue,
  type SendPolicy,
} from '../_lib/autopilot';
import { buildRecipeStages, policyView, pipelineConfigFromRecipe, type RecipeStages } from '../_lib/recipe';
import { isPaidPlan } from '../../shared/plans';
import { recordContacted } from '../_lib/contacted';
import type {
  ContactDoc,
  EmailSequenceDoc,
  MissionRecipeDoc,
  PipelineRunDoc,
  ProfileDoc,
  SendStage,
  SentMessageDoc,
} from '../../shared/schemas';

/** What gateAndQueue needs about a recipe: the flattened send view for the gate
 *  + scheduling, plus the ids/stage it writes the daily counter back onto. */
export interface AutopilotCtx {
  recipeId: string;
  missionId: string;
  view: SendPolicy;
  send: SendStage;
}

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
  sourceError?: string;
  gateError?: string;
}

export default async function handler(req: Request, res: Response) {
  if (!requireCronSecret(req, res)) return;

  const db = await adminDb();
  const now = new Date();
  const recipes = await db
    .collection<MissionRecipeDoc>('mission_recipes')
    .find({ automationEnabled: true })
    .limit(MAX_POLICIES)
    .toArray();

  const outcomes: PolicyOutcome[] = [];

  for (const raw of recipes) {
    // Normalize so a partial/legacy stored recipe reads complete + clamped.
    const stages = buildRecipeStages({ mission: { findMode: raw.sourcing?.findMode ?? null }, partial: raw });
    const view = policyView(stages);
    const uid = raw.userId;
    const scope = forUser(uid);
    const ctx: AutopilotCtx = { recipeId: raw._id, missionId: raw.missionId, view, send: stages.send };
    const out: PolicyOutcome = { policyId: raw._id, sourced: false, gated: 0, queued: 0, reviewed: 0, ready: 0 };

    // 1. Plan gate (authoritative - the UI also hides the toggle for free).
    try {
      const profile = await scope.collection<ProfileDoc>('profiles').findOne();
      if (!isPaidPlan(profile?.plan, profile?.planStatus)) {
        out.skipped = 'not_paid';
        outcomes.push(out);
        continue;
      }
    } catch (err) {
      out.skipped = errMsg(err);
      console.error('[autopilot] plan check failed', ctx.recipeId, err);
      outcomes.push(out);
      continue;
    }

    // 2. Sourcing: nudge any stale live run, else start one on cadence.
    // Isolated so a sourcing failure NEVER prevents gating of drafts that already
    // exist - the two are independent and the queue must keep moving regardless.
    try {
      const liveRuns = (await scope
        .collection<PipelineRunDoc>('pipeline_runs')
        .find({ missionId: ctx.missionId, status: { $in: ['pending', 'running'] } as never })) as PipelineRunDoc[];
      if (liveRuns.length > 0) {
        for (const r of liveRuns) resumeIfStale({ id: uid, email: null }, r);
      } else if (sourcingDue(view, now)) {
        await startSourcing(scope, uid, ctx.missionId, stages);
        await scope
          .collection<MissionRecipeDoc>('mission_recipes')
          .updateById(ctx.recipeId, { send: { ...stages.send, lastSourcedAt: now } });
        out.sourced = true;
      }
    } catch (err) {
      out.sourceError = errMsg(err);
      console.error('[autopilot] sourcing failed', ctx.recipeId, err);
    }

    // 3+4. Gate fresh drafts → review/ready and, when auto-send is on, queue the
    // clean ones. Isolated from sourcing (above) and internally per-draft, so one
    // bad draft can't strand the rest of the batch.
    try {
      await gateAndQueue(scope, ctx, now, out);
    } catch (err) {
      out.gateError = errMsg(err);
      console.error('[autopilot] gating failed', ctx.recipeId, err);
    }

    outcomes.push(out);
  }

  console.info('[autopilot] tick', { recipes: recipes.length, outcomes });
  return res.status(200).json({ policies: recipes.length, outcomes });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : 'failed';
}

/**
 * Gate a policy's un-verdicted drafts and, when auto-send is on, queue the clean
 * ones within the daily cap + send window. Mutates `out` with the tallies.
 * Exported so the manual "cycle now" endpoint gates the backlog immediately
 * instead of leaving it for the next hourly tick. Each draft is isolated: a
 * failure on one is logged and skipped, never aborting the whole batch.
 */
export async function gateAndQueue(
  scope: ReturnType<typeof forUser>,
  ctx: AutopilotCtx,
  now: Date,
  out: PolicyOutcome,
): Promise<void> {
  const drafts = ((await scope
    .collection<EmailSequenceDoc>('email_sequences')
    .find({ missionId: ctx.missionId, status: 'draft' })) as EmailSequenceDoc[])
    .filter((s) => !s.autopilotState)
    .slice(0, MAX_DRAFTS_PER_POLICY);

  const passing: Array<{ seq: EmailSequenceDoc; contact: ContactDoc }> = [];
  for (const seq of drafts) {
    try {
      const contact = await scope.collection<ContactDoc>('contacts').findById(seq.contactId);
      if (!contact) continue;
      out.gated++;
      const toEmail = contact.email?.trim();
      // Autopilot eligibility (verified email + confidence). Fail → human review.
      if (!toEmail || gateDecision(contact, ctx.view) === 'review') {
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
      if (!ctx.view.autoSend) {
        await setState(scope, seq._id, 'ready');
        out.ready++;
        continue;
      }
      passing.push({ seq, contact });
    } catch (err) {
      console.error('[autopilot] draft gate failed', seq._id, err);
    }
  }

  // Auto-send: queue scheduled sends within the daily cap + send window.
  if (ctx.view.autoSend && passing.length > 0) {
    const cap = remainingCapToday(ctx.view, now);
    const queueable: Array<{ seq: EmailSequenceDoc; toEmail: string; contact: ContactDoc }> = [];
    for (const { seq, contact } of passing) {
      if (queueable.length >= cap) break;
      try {
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
      } catch (err) {
        console.error('[autopilot] queue-eligibility failed', seq._id, err);
      }
    }

    const slots = nextSendSlots(ctx.view, queueable.length, now);
    for (let i = 0; i < queueable.length; i++) {
      const { seq, toEmail, contact } = queueable[i];
      try {
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
      } catch (err) {
        console.error('[autopilot] queueSend failed', seq._id, err);
      }
    }
    if (out.queued > 0) {
      await scope
        .collection<MissionRecipeDoc>('mission_recipes')
        .updateById(ctx.recipeId, { send: { ...ctx.send, counter: bumpedCounter(ctx.view, now, out.queued) } });
    }
  }
}

/** Kick off a background sourcing run straight from the mission's recipe - the
 *  single source of truth. (This replaces the old behavior of inheriting the last
 *  manual run's config, which the user couldn't see or steer.) Exported so the
 *  manual "cycle now" endpoint sources on the same path as the cron.
 *
 *  The pipeline config comes entirely from the recipe stages. */
export async function startSourcing(
  scope: ReturnType<typeof forUser>,
  uid: string,
  missionId: string,
  stages: RecipeStages,
): Promise<void> {
  const cfg = pipelineConfigFromRecipe(stages);
  await startPipeline({
    user: { id: uid, email: null },
    missionId,
    targetCount: cfg.targetCount,
    topN: cfg.topN,
    topContacts: cfg.topContacts,
    selectedFunctions: cfg.selectedFunctions,
    selectedSeniority: cfg.selectedSeniority,
    selectedSectors: cfg.selectedSectors,
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
