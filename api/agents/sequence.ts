// Sequence agent - the LIVE drafting path (pipeline + MissionPage "draft").
//
// The initial email now goes through the personalization engine
// (assemble → grounded generate → verify → tiered revise), persona-aware, with
// a single 'bulk'-tier critique pass. Follow-ups are generated as a cheap,
// separate flash pass seeded with the approved initial. The persisted
// email_sequences doc shape is unchanged so send.ts / MissionPage keep working.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { generateJson, MODEL } from '../_lib/llm';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { embedOne } from '../_lib/embeddings';
import { runDraftEngine, ensureSignOff } from '../_lib/engine';
import { resolvePersona, assembleDraftContext, isDraftContextCache } from '../_lib/assemble';
import type {
  ContactDoc,
  EmailSequenceDoc,
  EvidencePackDoc,
  MissionDoc,
  SentMessageDoc,
  TargetDoc,
} from '../../shared/schemas';

interface FollowupOut {
  wait_days: number;
  subject: string;
  body: string;
}

const FOLLOWUPS_SCHEMA = {
  type: 'object',
  properties: {
    followups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          wait_days: { type: 'number' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['wait_days', 'subject', 'body'],
      },
    },
  },
  required: ['followups'],
} as const;

const FOLLOWUPS_SYSTEM = `You write 2 short follow-up emails for a cold outreach sequence. They reference the original lightly, add no new factual claims, stay in the sender's voice, and each end with one low-friction CTA. Each email MUST end with a short sign-off ("Best,") followed by the sender's name on the next line - use the sender name provided verbatim, never a placeholder like "[Your Name]". Keep each under 70 words. wait_days: first ~3, second ~6. Output JSON only.`;

// Pull evidence-bullet indices a draft actually cited, from "evidence:<pack>:<i>"
// factIds - preserves the old anchoredBullets telemetry against the latest pack.
function anchoredFromClaims(claims: Array<{ factId: string }>, packId: string | null): number[] {
  if (!packId) return [];
  const idx = new Set<number>();
  for (const c of claims) {
    const m = /^evidence:(.+):(\d+)$/.exec(c.factId ?? '');
    if (m && m[1] === packId) idx.add(Number(m[2]));
  }
  return [...idx].sort((a, b) => a - b);
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { contact_id, draft_context_cache } = (req.body ?? {}) as { contact_id?: string; draft_context_cache?: unknown };
  const draftContextCache = isDraftContextCache(draft_context_cache) ? draft_context_cache : undefined;
  if (!contact_id) return res.status(400).json({ error: 'missing_contact_id' });

  const contact = await scope.collection<ContactDoc>('contacts').findById(contact_id);
  if (!contact) return res.status(404).json({ error: 'contact_not_found' });
  const target = await scope.collection<TargetDoc>('targets').findById(contact.targetId);
  if (!target) return res.status(404).json({ error: 'target_not_found' });
  const mission = await scope.collection<MissionDoc>('missions').findById(target.missionId);
  if (!mission) return res.status(404).json({ error: 'mission_not_found' });

  // Latest evidence pack (grounding source; also enforced as a precondition so
  // the pipeline always runs evidence → sequence in order).
  const packs = await scope.collection<EvidencePackDoc>('evidence_packs').find({ targetId: target._id });
  packs.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  const latestPack = packs[0] ?? null;
  if (!latestPack || latestPack.bullets.length === 0) {
    return res.status(409).json({ error: 'no_evidence_pack', message: 'Generate an evidence pack first.' });
  }

  const run = await startRun(scope, {
    agentType: 'sequence',
    missionId: mission._id,
    targetId: target._id,
    contactId: contact_id,
  });

  try {
    const persona = await resolvePersona(scope, mission.personaId, draftContextCache);
    const { ctx, factIds, exemplarIds, personaVersion } = await assembleDraftContext(scope, user.id, {
      contact,
      target,
      mission,
      persona,
    }, draftContextCache);

    // Initial email - grounded engine, single critique pass (bulk tier).
    const result = await runDraftEngine(ctx, 'bulk');
    const { subject, body, angle, claims } = result.draft;

    // Idempotent regenerate: a "draft" is one-per-contact, so replace any prior
    // UNSENT draft for this contact instead of stacking a duplicate row. Without
    // this, re-running the pipeline (or autopilot sourcing) accumulates rows that
    // (a) inflate the draft counts in the missions list / dashboard / header and
    // (b) make autopilot-tick gate & draft the same contact twice. Only delete
    // drafts that have NO sent_messages referencing them, so scheduled or
    // already-sent history is never touched.
    const priorDrafts = await scope
      .collection<EmailSequenceDoc>('email_sequences')
      .find({ contactId: contact_id, status: 'draft' });
    if (priorDrafts.length > 0) {
      const priorIds = priorDrafts.map((s) => s._id);
      const refs = await scope
        .collection<SentMessageDoc>('sent_messages')
        .find({ sequenceId: { $in: priorIds } });
      const referenced = new Set(refs.map((m) => m.sequenceId));
      const deletable = priorIds.filter((id) => !referenced.has(id));
      if (deletable.length > 0) {
        await scope
          .collection<EmailSequenceDoc>('email_sequences')
          .deleteMany({ _id: { $in: deletable } });
      }
    }

    const row = await scope.collection<EmailSequenceDoc>('email_sequences').insertOne({
      _id: newId(),
      contactId: contact_id,
      targetId: target._id,
      missionId: mission._id,
      evidencePackId: latestPack._id,
      primaryAngle: angle || null,
      anchoredBullets: anchoredFromClaims(claims, latestPack._id),
      subject,
      body,
      // Immutable baseline for the edit-delta (learning loop compares vs final).
      originalSubject: subject,
      originalBody: body,
      followups: [],
      status: 'draft',
      scheduledSendAt: null,
      sentAt: null,
      profileVersionId: null,
    } as InsertDoc<EmailSequenceDoc>);

    // Embed off the critical path - the vector only feeds downstream search, so
    // don't make the caller wait on it. Best-effort.
    void (async () => {
      try {
        const embedding = await embedOne(`${subject}\n\n${body}`, 'document');
        await scope.collection<EmailSequenceDoc>('email_sequences').updateById(row._id, { embedding } as Partial<EmailSequenceDoc>);
      } catch (err) {
        console.warn('embed_sequence_failed', err);
      }
    })();

    // Follow-ups are useful, but the initial personalized email is the critical
    // pipeline deliverable. Fill them in asynchronously so bulk runs do not wait
    // on one extra LLM call per contact before marking a draft ready.
    void (async () => {
      try {
        const followups = await generateFollowups(ctx.recipient.name, mission.goal, subject, body, ctx.sender?.name ?? null);
        if (followups.length > 0) {
          await scope.collection<EmailSequenceDoc>('email_sequences').updateById(row._id, { followups } as Partial<EmailSequenceDoc>);
        }
      } catch (err) {
        console.warn('generate_followups_failed', err);
      }
    })();

    await completeRun(scope, run._id, {
      sequence_id: row._id,
      persona_id: persona?._id ?? null,
      persona_version: personaVersion,
      pass: result.pass,
      revisions: result.revisions,
      voice_match_score: result.voiceMatchScore,
      violations: result.violations,
      violation_count: result.violations.length,
      fact_ids: factIds,
      exemplar_ids: exemplarIds,
      claims,
    });
    return res.status(200).json({ run_id: run._id, sequence: row });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}

async function generateFollowups(
  recipientName: string,
  missionGoal: string,
  subject: string,
  body: string,
  senderName: string | null
): Promise<Array<{ waitDays: number; subject: string; body: string }>> {
  try {
    const r = await generateJson<{ followups: FollowupOut[] }>({
      model: MODEL(),
      max_tokens: 1024,
      temperature: 0.5,
      system: FOLLOWUPS_SYSTEM,
      responseJsonSchema: FOLLOWUPS_SCHEMA,
      messages: [
        {
          role: 'user',
          content: [
            `Recipient: ${recipientName}`,
            `Sender (sign off as): ${senderName ?? 'unknown - close with "Best," and no placeholder name'}`,
            `Mission goal / offer: ${missionGoal}`,
            `Original email:\nSubject: ${subject}\n\n${body}`,
            'Write 2 follow-ups, each ending with a sign-off. JSON only.',
          ].join('\n\n'),
        },
      ],
    });
    if (!r.ok || !Array.isArray(r.data?.followups)) return [];
    return r.data.followups.slice(0, 2).map((f) => ({
      waitDays: typeof f.wait_days === 'number' ? f.wait_days : 3,
      subject: f.subject,
      // Guarantee each follow-up is signed, same as the initial email.
      body: ensureSignOff(f.body, senderName),
    }));
  } catch {
    return []; // follow-ups are non-critical; never fail the draft over them
  }
}
