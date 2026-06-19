// The single send-time gate every path runs before a real send: suppression →
// content lint → LLM moderation (cached) → warmup/volume caps. Returns a clear
// block reason (with a code so callers can distinguish "fix the content" from
// "over cap, try later") or a list of soft warnings a manual sender may accept.
//
// This is the chokepoint that keeps OutreachOS off blocklists: it runs in
// api/gmail/send.ts AND both sending crons, so no path can bypass it.

import type { UserScope } from './db';
import type { EmailSequenceDoc, SentMessageDoc, UserIntegrationDoc } from '../../shared/schemas';
import { isSuppressed } from './sequencing';
import { lintContent } from './content-guard';
import { moderate, type ModerationCache } from './content-moderation';
import {
  checkSendAllowance,
  connectionAgeDays,
  recipientDomain,
} from './sending-limits';

export interface SendEvaluation {
  /** true ⇒ the send may proceed (possibly with warnings). */
  ok: boolean;
  blocked: boolean;
  /** Stable code so callers can branch (content vs cap vs suppression). */
  blockCode?: 'suppressed' | 'content' | 'moderation' | 'account_daily_cap' | 'domain_daily_cap';
  blockReason?: string;
  warnings: string[];
  /** When moderation ran fresh, the verdict to persist on the sequence. */
  moderationToPersist?: ModerationCache;
}

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export async function evaluateSend(
  scope: UserScope,
  args: {
    toEmail: string;
    subject: string;
    body: string;
    moderationCache?: EmailSequenceDoc['moderation'];
    now?: Date;
  },
): Promise<SendEvaluation> {
  const now = args.now ?? new Date();
  const warnings: string[] = [];

  // 1. Suppression - never send to an opted-out / bounced address.
  if (await isSuppressed(scope, args.toEmail)) {
    return { ok: false, blocked: true, blockCode: 'suppressed', blockReason: 'This address is on your suppression list.', warnings };
  }

  // 2. Deterministic content lint.
  const lint = lintContent({ subject: args.subject, body: args.body });
  for (const i of lint.issues) if (i.severity === 'warn') warnings.push(i.message);
  if (lint.severity === 'block') {
    const first = lint.issues.find((i) => i.severity === 'block');
    return { ok: false, blocked: true, blockCode: 'content', blockReason: first?.message ?? 'Content blocked by the spam check.', warnings };
  }

  // 3. LLM moderation (abuse/policy), reusing the cached verdict when unchanged.
  const mod = await moderate(
    { subject: args.subject, body: args.body },
    { cache: args.moderationCache ?? null },
  );
  const moderationToPersist: ModerationCache | undefined = mod.fromCache
    ? undefined
    : { allowed: mod.verdict.allowed, category: mod.verdict.category, contentHash: mod.hash, checkedAt: now };
  if (!mod.verdict.allowed) {
    return {
      ok: false,
      blocked: true,
      blockCode: 'moderation',
      blockReason: `Blocked by content policy${mod.verdict.category ? ` (${mod.verdict.category})` : ''}: ${mod.verdict.reason}`,
      warnings,
      moderationToPersist,
    };
  }

  // 4. Warmup + volume caps (per account/day and per recipient-domain/day).
  const integration = await scope.collection<UserIntegrationDoc>('user_integrations').findOne({ provider: 'gmail' });
  const ageDays = connectionAgeDays(integration?.createdAt ?? null, now);
  const dayStart = startOfUtcDay(now);
  const todays = (await scope
    .collection<SentMessageDoc>('sent_messages')
    .find({ status: 'sent', sentAt: { $gte: dayStart } })) as SentMessageDoc[];
  const sentToday = todays.length;
  const domain = recipientDomain(args.toEmail);
  const sentToDomainToday = domain
    ? todays.filter((m) => recipientDomain(m.toEmail) === domain).length
    : 0;

  const allowance = checkSendAllowance({ ageDays, sentToday, sentToDomainToday });
  if (!allowance.allowed) {
    const reason =
      allowance.reason === 'domain_daily_cap'
        ? `Daily limit for ${domain} reached. It will resume tomorrow.`
        : `Daily send limit reached (${allowance.capToday}/day while your account warms up). It resumes tomorrow.`;
    return { ok: false, blocked: true, blockCode: allowance.reason, blockReason: reason, warnings, moderationToPersist };
  }

  return { ok: true, blocked: false, warnings, moderationToPersist };
}
