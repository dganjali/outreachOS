// Onboarding agent - adaptive clarifying questions (Stage 3).
//
// Reads everything gathered so far (persona frame + context facts + exemplars)
// and asks the 3–5 questions with the highest information gain: gaps in the
// substance, contradictions, or missing voice signals. Cheap flash tier.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { generateJson, MODEL } from '../_lib/llm';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import type { ContextFactDoc, PersonaDoc, StyleExemplarDoc } from '../../shared/schemas';

interface QuestionsOut {
  questions: Array<{ id: string; question: string; why: string }>;
}

const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['id', 'question', 'why'],
      },
    },
  },
  required: ['questions'],
} as const;

const SYSTEM = `You help a user write better cold outreach by collecting the few CORE facts an email needs to be concrete and credible. Given what we already know (their offer/audience and any facts/examples), ask the 3 SIMPLEST, highest-impact questions that fill the biggest gaps in the core content of an email.

Prioritize, in order:
1. A concrete proof point or specific result they can cite (numbers, names, outcomes) - this is what makes an email non-generic.
2. Exactly who they want to reach and what they want them to do (the ask / CTA).
3. The single most relevant detail about their offer that a recipient would care about.

Rules:
- Ask at most 3 questions. Fewer is better if the gaps are already filled.
- Each question must be plain, specific, and answerable in ONE short sentence. No compound or open-ended "tell me about..." questions.
- Never ask about anything already answered by the facts/offer/audience.
- Keep "why" to a short phrase (what it unlocks in the email).
Output JSON only.`;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { persona_id } = (req.body ?? {}) as { persona_id?: string };
  if (!persona_id) return res.status(400).json({ error: 'missing_persona_id' });

  const persona = await scope.collection<PersonaDoc>('personas').findById(persona_id);
  if (!persona) return res.status(404).json({ error: 'persona_not_found' });

  const facts = await scope.collection<ContextFactDoc>('context_facts').find({
    $or: [{ scope: 'person' }, { scope: 'persona', personaId: persona_id }],
  } as Record<string, unknown>);
  const exemplars = await scope.collection<StyleExemplarDoc>('style_exemplars').find({ personaId: persona_id });

  const run = await startRun(scope, { agentType: 'onboard_questions', missionId: null, targetId: null, contactId: null });

  const factText = facts.length
    ? facts.map((f) => `- (${f.type}) ${f.claim}`).join('\n')
    : '(no substance captured yet)';
  const exemplarText = exemplars.length
    ? exemplars.map((e, i) => `Example ${i + 1}: ${e.body.slice(0, 400)}`).join('\n\n')
    : '(no example emails yet)';

  const userPrompt = [
    `PERSONA: ${persona.name}${persona.mode ? ` (${persona.mode})` : ''}`,
    persona.offer ? `OFFER: ${persona.offer}` : '',
    persona.audience ? `AUDIENCE: ${persona.audience}` : '',
    '',
    `SUBSTANCE / FACTS:\n${factText}`,
    '',
    `EXAMPLE EMAILS:\n${exemplarText}`,
    '',
    'Ask at most 3 simple, core clarifying questions. JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const r = await generateJson<QuestionsOut>({
      model: MODEL(),
      max_tokens: 1024,
      temperature: 0.4,
      system: SYSTEM,
      responseJsonSchema: SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!r.ok || !Array.isArray(r.data?.questions)) {
      await failRun(scope, run._id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: r.raw.slice(0, 500) });
    }
    const questions = r.data.questions.slice(0, 3);
    await completeRun(scope, run._id, { persona_id, count: questions.length });
    return res.status(200).json({ run_id: run._id, questions });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}
