import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { createMessageWithRetry, MODEL, extractJson } from '../_lib/anthropic';
import { REPLY_ROUTER_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import type {
  ContactDoc,
  EmailSequenceDoc,
  MissionDoc,
  ProfileDoc,
  ReplyDoc,
  SentMessageDoc,
} from '../../shared/schemas';

interface ReplyClassification {
  classification: string;
  urgency: 'low' | 'normal' | 'high';
  key_points: string[];
  suggested_response: { subject: string; body: string } | null;
  recommended_action: string;
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { reply_id } = (req.body ?? {}) as { reply_id?: string };
  if (!reply_id) return res.status(400).json({ error: 'missing_reply_id' });

  const reply = await scope.collection<ReplyDoc>('replies').findById(reply_id);
  if (!reply) return res.status(404).json({ error: 'reply_not_found' });

  const sent = reply.sentMessageId
    ? await scope.collection<SentMessageDoc>('sent_messages').findById(reply.sentMessageId)
    : null;
  const sequence = sent
    ? await scope.collection<EmailSequenceDoc>('email_sequences').findById(sent.sequenceId)
    : null;
  const contact = sent
    ? await scope.collection<ContactDoc>('contacts').findById(sent.contactId)
    : null;
  const mission = sent
    ? await scope.collection<MissionDoc>('missions').findById(sent.missionId)
    : null;

  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  const run = await startRun(scope, {
    agentType: 'reply',
    missionId: mission?._id ?? null,
    contactId: contact?._id ?? null,
  });

  void sequence; // currently unused — sequence context is implicit via `sent`

  const userPrompt = [
    'ORIGINAL OUTREACH (what we sent)',
    sent ? `Subject: ${sent.subject}\n\n${sent.body}` : '(unknown — could not match thread)',
    '',
    'REPLY (what they sent back)',
    `From: ${reply.fromEmail ?? '(unknown)'}`,
    `Subject: ${reply.subject ?? ''}`,
    '',
    reply.body || reply.snippet || '(empty body)',
    '',
    'CONTEXT',
    contact ? `Recipient: ${contact.name} (${contact.role})` : '',
    mission ? `Mission goal: ${mission.goal}` : '',
    profile?.name ? `Sender: ${profile.name}${profile.role ? `, ${profile.role}` : ''}` : '',
    profile?.writingTone ? `Sender tone: ${profile.writingTone}` : '',
    '',
    'Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 1024,
      system: REPLY_ROUTER_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const parsed = extractJson<ReplyClassification>(message);
    if (!parsed.ok || !parsed.data) {
      await failRun(scope, run._id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
    }

    const cls = parsed.data;
    await scope.collection<ReplyDoc>('replies').updateById(reply_id, {
      classification: cls.classification as ReplyDoc['classification'],
      urgency: cls.urgency,
      keyPoints: cls.key_points,
      suggestedResponse: cls.suggested_response,
      recommendedAction: cls.recommended_action,
    });

    if (contact && (cls.classification === 'unsubscribe' || cls.classification === 'not_now')) {
      // Stop the sequence — no more follow-ups
      const sentMessages = await scope
        .collection<SentMessageDoc>('sent_messages')
        .find({ contactId: contact._id, status: 'queued' });
      for (const sm of sentMessages) {
        await scope.collection<SentMessageDoc>('sent_messages').updateById(sm._id, {
          status: 'failed',
          failedReason: `suppressed_${cls.classification}`,
        });
      }
    }
    if (contact) {
      await scope.collection<ContactDoc>('contacts').updateById(contact._id, { status: 'replied' });
    }

    await completeRun(scope, run._id, { classification: cls.classification });
    return res.status(200).json({ run_id: run._id, classification: cls });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
