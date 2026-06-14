// Extract-style agent — turns calibration signal into StyleProfile updates.
//
// Consumes any of: chat instructions (Stage-4 "make it less formal"), edit-deltas
// (original AI draft vs the human-edited final), and a confirmed gold exemplar.
// An LLM proposes a CONSERVATIVE delta; the confidence-weighted merge
// (style-merge.ts) decides how much to believe — a single noisy sample never
// overwrites a high-confidence dimension. Each commit bumps the persona's
// styleProfileVersion and snapshots a PersonaVersionDoc (audit + rollback).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { generateJson, MODEL } from '../_lib/llm';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { embedOne } from '../_lib/embeddings';
import { mergeStyleProfile, type StyleDelta } from '../_lib/style-merge';
import type { PersonaDoc, PersonaVersionDoc, StyleExemplarDoc } from '../../shared/schemas';

interface DeltaOut {
  dimensions: Array<{ name: string; value: number; confidence: number }>;
  rules: Array<{ rule: string; confidence: number }>;
  bannedPhrases: string[];
  voiceSummary: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'number' },
          confidence: { type: 'number' },
        },
        required: ['name', 'value', 'confidence'],
      },
    },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: { rule: { type: 'string' }, confidence: { type: 'number' } },
        required: ['rule', 'confidence'],
      },
    },
    bannedPhrases: { type: 'array', items: { type: 'string' } },
    voiceSummary: { type: 'string' },
  },
  required: ['dimensions', 'rules', 'bannedPhrases', 'voiceSummary'],
} as const;

const SYSTEM = `You extract a CONSERVATIVE style delta for a user's outreach persona from calibration signal. Rules:
- Known dimensions (0..1): formality, warmth, directness, hedging, emoji, jargon, enthusiasm, brevity. Only emit a dimension you have real evidence for.
- Confidence calibration: an EXPLICIT instruction ("make it less formal") → high confidence (0.7–0.9) because the user directly told us. An inference from a single edit-delta → low/medium (0.2–0.4). Never assert high confidence from one noisy sample.
- rules: only durable, explicit do/don'ts the user expressed. bannedPhrases: only phrases they clearly rejected.
- voiceSummary: a 1–2 sentence prose summary, or "" if you can't improve on what's known.
Output JSON only.`;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const body = (req.body ?? {}) as {
    persona_id?: string;
    chat_instructions?: string[];
    edit_deltas?: Array<{ original: string; final: string }>;
    confirmed_exemplar?: { subject?: string | null; body: string };
    source?: PersonaVersionDoc['source'];
  };
  const personaId = body.persona_id;
  if (!personaId) return res.status(400).json({ error: 'missing_persona_id' });

  const personas = scope.collection<PersonaDoc>('personas');
  const persona = await personas.findById(personaId);
  if (!persona) return res.status(404).json({ error: 'persona_not_found' });

  const source: PersonaVersionDoc['source'] = body.source ?? 'chat-instruction';
  const run = await startRun(scope, { agentType: 'extract_style', missionId: null, targetId: null, contactId: null });

  try {
    const signalParts: string[] = [];
    if (body.chat_instructions?.length) {
      signalParts.push(`EXPLICIT INSTRUCTIONS:\n${body.chat_instructions.map((s) => `- ${s}`).join('\n')}`);
    }
    if (body.edit_deltas?.length) {
      signalParts.push(
        `EDIT-DELTAS (AI draft → human final):\n${body.edit_deltas
          .slice(0, 8)
          .map((d, i) => `[${i + 1}] BEFORE: ${d.original}\n    AFTER:  ${d.final}`)
          .join('\n')}`
      );
    }
    if (body.confirmed_exemplar?.body) {
      signalParts.push(`CONFIRMED GOOD EMAIL:\n${body.confirmed_exemplar.body}`);
    }

    let delta: StyleDelta = { dimensions: {}, rules: [], bannedPhrases: [], voiceSummary: '' };
    if (signalParts.length > 0) {
      const r = await generateJson<DeltaOut>({
        model: MODEL(),
        max_tokens: 1024,
        temperature: 0.2, // deterministic extraction
        system: SYSTEM,
        responseJsonSchema: SCHEMA,
        messages: [{ role: 'user', content: `${signalParts.join('\n\n')}\n\nExtract the conservative style delta. JSON only.` }],
      });
      if (r.ok && r.data) {
        const dims: StyleDelta['dimensions'] = {};
        for (const d of r.data.dimensions ?? []) {
          if (d?.name) dims[d.name] = { value: d.value, confidence: d.confidence };
        }
        delta = {
          dimensions: dims,
          rules: r.data.rules ?? [],
          bannedPhrases: r.data.bannedPhrases ?? [],
          voiceSummary: r.data.voiceSummary ?? '',
        };
      }
    }

    const merged = mergeStyleProfile(persona.styleProfile, delta, source);
    const nextVersion = (persona.styleProfileVersion ?? 1) + 1;

    // First successful calibration marks the persona as onboarded (drives the
    // "Calibrated" indicators in the ME → Voice tab and the MissionNew gate).
    const markOnboarded = !persona.onboardingCompletedAt;

    await personas.updateById(personaId, {
      styleProfile: merged,
      styleProfileVersion: nextVersion,
      ...(markOnboarded ? { onboardingCompletedAt: new Date() } : {}),
    } as Partial<PersonaDoc>);

    // Immutable snapshot for audit + rollback.
    await scope.collection<PersonaVersionDoc>('persona_versions').insertOne({
      _id: newId(),
      personaId,
      snapshot: merged as unknown as Record<string, unknown>,
      source,
      version: nextVersion,
    } as InsertDoc<PersonaVersionDoc>);

    // Confirmed exemplar → first-class gold email (embedded for retrieval).
    let exemplarId: string | null = null;
    if (body.confirmed_exemplar?.body) {
      let embedding: number[] | undefined;
      try {
        embedding = await embedOne(body.confirmed_exemplar.body, 'document');
      } catch (err) {
        console.warn('embed_exemplar_failed', err);
      }
      const ex = await scope.collection<StyleExemplarDoc>('style_exemplars').insertOne({
        _id: newId(),
        personaId,
        subject: body.confirmed_exemplar.subject ?? null,
        body: body.confirmed_exemplar.body,
        mode: persona.mode,
        source: 'stage4-confirmed',
        outcome: 'unknown',
        ...(embedding ? { embedding } : {}),
      } as InsertDoc<StyleExemplarDoc>);
      exemplarId = ex._id;
    }

    await completeRun(scope, run._id, { persona_id: personaId, version: nextVersion, exemplar_id: exemplarId });
    return res.status(200).json({
      run_id: run._id,
      persona_id: personaId,
      style_profile: merged,
      style_profile_version: nextVersion,
      exemplar_id: exemplarId,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}
