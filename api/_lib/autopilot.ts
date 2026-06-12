// Campaign Autopilot engine — Act 1.2.
//
// Flips the unit of control from per-email approval to per-policy approval. The
// cron driver (api/cron/autopilot.ts) calls runAutopilot() on a schedule; for
// every enabled policy it:
//   1. Discovery — tops up the pipeline so there are always fresh targets to
//      work, reusing the durable pipeline from Act 1.1 (startPipeline).
//   2. Send sweep — auto-sends only the draft sequences that clear the
//      confidence gate AND the sending guardrails (daily cap + send window),
//      reusing the existing send handler verbatim (suppression, idempotency,
//      follow-up scheduling, reply-stop all come for free). Everything that
//      fails the gate stays a draft for the human to review.
//
// The decision logic (gate / window / budget) is pure and unit-tested; the
// driver does the IO around it.

import { adminDb, forUser, newId, type UserScope } from './db';
import type { AuthedUser } from './auth';
import { invokeAgent } from './internal-invoke';
import { startPipeline } from './pipeline';
import gmailSendHandler from '../gmail/send';
import type {
  AutopilotPolicyDoc,
  ContactDoc,
  EmailSequenceDoc,
  MissionDoc,
  PipelineRunDoc,
  SentMessageDoc,
} from '../../shared/schemas';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Policy defaults — a sane, conservative starting policy for a new mission.
// ---------------------------------------------------------------------------
export function defaultPolicyFields(): Omit<AutopilotPolicyDoc, keyof import('../../shared/schemas').BaseDoc | 'missionId'> {
  return {
    enabled: false,
    targetsPerWeek: 10,
    autoSend: false, // start in draft-only mode; the user opts into sending
    maxSendsPerDay: 15,
    sendWindowStartHour: 13, // ~9am–5pm US-Eastern, expressed in UTC
    sendWindowEndHour: 21,
    sendDays: [1, 2, 3, 4, 5], // weekdays
    minContactConfidence: 0.6,
    requireVerifiedEmail: true,
    lastDiscoveryAt: null,
    lastSweepAt: null,
  };
}

/** Clamp/normalize a client-supplied policy patch to safe ranges. */
export function sanitizePolicyPatch(patch: Record<string, unknown>): Partial<AutopilotPolicyDoc> {
  const out: Partial<AutopilotPolicyDoc> = {};
  const num = (v: unknown, lo: number, hi: number): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(hi, Math.max(lo, n));
  };
  if ('enabled' in patch) out.enabled = !!patch.enabled;
  if ('autoSend' in patch) out.autoSend = !!patch.autoSend;
  if ('requireVerifiedEmail' in patch) out.requireVerifiedEmail = !!patch.requireVerifiedEmail;
  const tpw = num(patch.targetsPerWeek, 0, 200); if (tpw !== undefined) out.targetsPerWeek = Math.round(tpw);
  const msd = num(patch.maxSendsPerDay, 0, 500); if (msd !== undefined) out.maxSendsPerDay = Math.round(msd);
  const s = num(patch.sendWindowStartHour, 0, 23); if (s !== undefined) out.sendWindowStartHour = Math.round(s);
  const e = num(patch.sendWindowEndHour, 0, 23); if (e !== undefined) out.sendWindowEndHour = Math.round(e);
  const mcc = num(patch.minContactConfidence, 0, 1); if (mcc !== undefined) out.minContactConfidence = mcc;
  if (Array.isArray(patch.sendDays)) {
    const days = [...new Set(patch.sendDays.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
    out.sendDays = days;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The confidence gate — pure. Decides whether a single draft may auto-send.
// ---------------------------------------------------------------------------
export interface GateInput {
  contactConfidence: number | null;
  emailStatus: ContactDoc['emailStatus'];
  hasEmail: boolean;
  hasEvidence: boolean;
}

export interface GateResult {
  pass: boolean;
  reason: 'ok' | 'no_email' | 'low_confidence' | 'unverified_email' | 'no_evidence';
}

export function evaluateGate(policy: Pick<AutopilotPolicyDoc, 'minContactConfidence' | 'requireVerifiedEmail'>, input: GateInput): GateResult {
  if (!input.hasEmail) return { pass: false, reason: 'no_email' };
  if ((input.contactConfidence ?? 0) < policy.minContactConfidence) return { pass: false, reason: 'low_confidence' };
  if (policy.requireVerifiedEmail && input.emailStatus !== 'verified' && input.emailStatus !== 'likely') {
    return { pass: false, reason: 'unverified_email' };
  }
  if (!input.hasEvidence) return { pass: false, reason: 'no_evidence' };
  return { pass: true, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Sending guardrails — pure.
// ---------------------------------------------------------------------------
export function withinSendWindow(
  policy: Pick<AutopilotPolicyDoc, 'sendWindowStartHour' | 'sendWindowEndHour' | 'sendDays'>,
  now: Date
): boolean {
  if (policy.sendDays.length > 0 && !policy.sendDays.includes(now.getUTCDay())) return false;
  const h = now.getUTCHours();
  const { sendWindowStartHour: s, sendWindowEndHour: e } = policy;
  if (s === e) return true; // full-day window
  if (s < e) return h >= s && h < e;
  return h >= s || h < e; // window wraps past midnight
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Driver.
// ---------------------------------------------------------------------------
export interface AutopilotSummary {
  policies: number;
  discoveriesStarted: number;
  sent: number;
  held: number;
  errors: Array<{ missionId: string; error: string }>;
}

export async function runAutopilot(now: Date = new Date()): Promise<AutopilotSummary> {
  const db = await adminDb();
  const policies = await db.collection<AutopilotPolicyDoc>('autopilot_policies').find({ enabled: true }).toArray();

  const summary: AutopilotSummary = { policies: policies.length, discoveriesStarted: 0, sent: 0, held: 0, errors: [] };

  for (const policy of policies) {
    const user: AuthedUser = { id: policy.userId, email: null };
    const scope = forUser(policy.userId);
    try {
      const mission = await scope.collection<MissionDoc>('missions').findById(policy.missionId);
      if (!mission || mission.archivedAt) continue; // mission gone/archived — skip

      if (await maybeDiscover(scope, user, policy, now)) summary.discoveriesStarted++;

      const res = await maybeSend(scope, user, policy, now);
      summary.sent += res.sent;
      summary.held += res.held;

      await scope.collection<AutopilotPolicyDoc>('autopilot_policies').updateById(policy._id, { lastSweepAt: now });
    } catch (err) {
      summary.errors.push({ missionId: policy.missionId, error: err instanceof Error ? err.message : 'autopilot_failed' });
    }
  }

  return summary;
}

/** Top up discovery: start a pipeline if below the weekly target quota and none is live. */
async function maybeDiscover(scope: UserScope, user: AuthedUser, policy: AutopilotPolicyDoc, now: Date): Promise<boolean> {
  if (policy.targetsPerWeek <= 0) return false;

  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const recent = await scope
    .collection<{ createdAt: Date }>('targets')
    .countDocuments({ missionId: policy.missionId, createdAt: { $gte: weekAgo } } as never);
  if (recent >= policy.targetsPerWeek) return false;

  const live = await scope
    .collection<PipelineRunDoc>('pipeline_runs')
    .findOne({ missionId: policy.missionId, status: { $in: ['pending', 'running'] } as never });
  if (live) return false;

  await startPipeline({ user, missionId: policy.missionId });
  await scope.collection<AutopilotPolicyDoc>('autopilot_policies').updateById(policy._id, { lastDiscoveryAt: now });
  return true;
}

/** Auto-send the draft sequences that clear the gate, within the daily cap and window. */
async function maybeSend(
  scope: UserScope,
  user: AuthedUser,
  policy: AutopilotPolicyDoc,
  now: Date
): Promise<{ sent: number; held: number }> {
  if (!policy.autoSend) return { sent: 0, held: 0 };
  if (!withinSendWindow(policy, now)) return { sent: 0, held: 0 };

  const sentToday = await scope
    .collection<SentMessageDoc>('sent_messages')
    .countDocuments({ missionId: policy.missionId, status: 'sent', sentAt: { $gte: startOfUtcDay(now) } } as never);
  let budget = policy.maxSendsPerDay - sentToday;
  if (budget <= 0) return { sent: 0, held: 0 };

  const drafts = await scope
    .collection<EmailSequenceDoc>('email_sequences')
    .find({ missionId: policy.missionId, status: 'draft' } as never);

  let sent = 0;
  let held = 0;
  for (const seq of drafts) {
    if (budget <= 0) break;
    const contact = await scope.collection<ContactDoc>('contacts').findById(seq.contactId);
    if (!contact) continue;

    const gate = evaluateGate(policy, {
      contactConfidence: contact.confidence,
      emailStatus: contact.emailStatus,
      hasEmail: !!contact.email?.trim(),
      hasEvidence: !!seq.evidencePackId,
    });
    if (!gate.pass) {
      held++;
      continue; // left as a draft — surfaces for human review
    }

    // Reuse the real send handler: suppression, idempotency, follow-up
    // scheduling and reply-stop all run exactly as for a manual send.
    const r = await invokeAgent(gmailSendHandler, {
      user,
      body: { sequence_id: seq._id, touch_index: 0, mode: 'send' },
    });
    if (r.status === 200) {
      sent++;
      budget--;
    }
    // 412 (gmail not connected) / 409 (suppressed / already sent) → quietly skip.
  }

  return { sent, held };
}
