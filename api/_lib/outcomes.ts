// Per-fact / per-exemplar outcome attribution - generalizes coach.ts's
// per-profile-field reply-rate join down to the grounding atoms. The draft +
// sequence agents log which `fact_ids` / `exemplar_ids` went into a contact's
// email (agent_runs.output). When that email is sent or gets a reply, we credit
// those exact facts/exemplars: `context_facts.replyStats.{sent,replied}` and
// `style_exemplars.outcome`. This is what lets the engine later prefer the facts
// and exemplars that actually earn replies.
//
// Reply visibility is weak today (Gmail send-only scope), so this is a bonus
// signal layered on top of edit-deltas - always best-effort, never blocking.

import { adminDb } from './db';
import type { AgentRunDoc } from '../../shared/schemas';

/** Read the fact/exemplar ids the latest draft for this contact was built from. */
async function lineageForContact(
  uid: string,
  contactId: string
): Promise<{ factIds: string[]; exemplarIds: string[] }> {
  const db = await adminDb();
  const run = (await db
    .collection('agent_runs')
    .find({ userId: uid, contactId, agentType: { $in: ['sequence', 'draft'] }, status: 'completed' })
    .sort({ createdAt: -1 })
    .limit(1)
    .next()) as (AgentRunDoc & { output?: Record<string, unknown> }) | null;
  const out = run?.output ?? {};
  const factIds = Array.isArray(out.fact_ids) ? (out.fact_ids as string[]) : [];
  const exemplarIds = Array.isArray(out.exemplar_ids) ? (out.exemplar_ids as string[]) : [];
  // Evidence "facts" are synthetic ids (evidence:<pack>:<i>) - only persisted
  // ContextFacts have a row to update.
  return { factIds: factIds.filter((id) => !id.startsWith('evidence:')), exemplarIds };
}

/**
 * Credit the facts/exemplars behind this contact's email with an outcome.
 * `kind:'sent'` bumps replyStats.sent; `kind:'replied'` bumps replyStats.replied
 * AND marks the exemplars as having earned a reply. Best-effort.
 */
export async function recordOutcome(uid: string, contactId: string, kind: 'sent' | 'replied'): Promise<void> {
  try {
    const { factIds, exemplarIds } = await lineageForContact(uid, contactId);
    if (factIds.length === 0 && exemplarIds.length === 0) return;
    const db = await adminDb();

    if (factIds.length > 0) {
      const field = kind === 'sent' ? 'replyStats.sent' : 'replyStats.replied';
      await db
        .collection('context_facts')
        .updateMany({ userId: uid, _id: { $in: factIds } } as Record<string, unknown>, {
          $inc: { [field]: 1 },
          $set: { updatedAt: new Date() },
        });
    }

    if (kind === 'replied' && exemplarIds.length > 0) {
      await db
        .collection('style_exemplars')
        .updateMany({ userId: uid, _id: { $in: exemplarIds } } as Record<string, unknown>, {
          $set: { outcome: 'replied', updatedAt: new Date() },
        });
    }
  } catch (err) {
    console.warn('record_outcome_failed', err);
  }
}
