// Refine agent - the Stage-4 (and runtime) canvas chat editor.
//
// Two modes:
//   - span:       rewrite ONLY the highlighted span per the instruction, leave
//                 the rest of the email byte-for-byte intact.
//   - structural: rewrite the whole email per the instruction.
// Either way the sender's voice (style profile + banned phrases) is preserved.
// The instruction is the user's words and is returned so the caller can log it
// as a calibration signal (extract-style turns it into conservative rules).

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { generateJson, MODEL, MODEL_PRO } from '../_lib/llm';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { emptyStyleProfile, type PersonaDoc, type StyleProfile } from '../../shared/schemas';

interface RefineOut {
  subject: string;
  body: string;
  // One short sentence on what changed and why - doubles as inline feedback in
  // the email editor. Optional so older callers/parses still satisfy the schema.
  note?: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['subject', 'body'],
} as const;

function styleBlock(sp: StyleProfile): string {
  const lines: string[] = [];
  if (sp.voiceSummary) lines.push(`Voice: ${sp.voiceSummary}`);
  if (sp.rules?.length) lines.push(`Rules: ${sp.rules.map((r) => r.rule).join('; ')}`);
  if (sp.bannedPhrases?.length) lines.push(`Never use: ${sp.bannedPhrases.join(', ')}`);
  return lines.join('\n') || '(no style profile yet)';
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);
  if (!(await checkRateLimit(scope, res))) return;

  const { persona_id, subject, body, instruction, span } = (req.body ?? {}) as {
    persona_id?: string;
    subject?: string;
    body?: string;
    instruction?: string;
    span?: string;
  };
  if (!body || !instruction) return res.status(400).json({ error: 'missing_body_or_instruction' });

  let sp: StyleProfile = emptyStyleProfile();
  if (persona_id) {
    const persona = await scope.collection<PersonaDoc>('personas').findById(persona_id);
    if (persona) sp = persona.styleProfile;
  }

  const mode: 'span' | 'structural' = span && body.includes(span) ? 'span' : 'structural';
  const run = await startRun(scope, { agentType: 'refine', missionId: null, targetId: null, contactId: null });

  const system =
    mode === 'span'
      ? `You edit one cold outreach email. Rewrite ONLY the highlighted span to satisfy the instruction; reproduce the rest of the body EXACTLY as given (no other changes). Preserve the sender's voice. Also write a "note": ONE short sentence (max ~15 words), addressed to the sender, on what you changed and why. Output the FULL updated subject + body plus the note as JSON.`
      : `You rewrite one cold outreach email to satisfy the instruction while preserving the sender's voice and any factual claims. Keep it tight and grounded - do not invent facts. Also write a "note": ONE short sentence (max ~15 words), addressed to the sender, on what you changed and why. Output the updated subject + body plus the note as JSON.`;

  const userPrompt = [
    `SENDER STYLE:\n${styleBlock(sp)}`,
    '',
    `CURRENT EMAIL:\nSubject: ${subject ?? ''}\n\n${body}`,
    mode === 'span' ? `\nHIGHLIGHTED SPAN (rewrite only this):\n"""${span}"""` : '',
    '',
    `INSTRUCTION: ${instruction}`,
    'Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const r = await generateJson<RefineOut>({
      // Span edits are small/local (flash); structural rewrites define quality (pro).
      model: mode === 'span' ? MODEL() : MODEL_PRO(),
      max_tokens: 1536,
      temperature: 0.6,
      system,
      responseJsonSchema: SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });
    if (!r.ok || !r.data?.body) {
      await failRun(scope, run._id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: r.raw.slice(0, 500) });
    }
    await completeRun(scope, run._id, { persona_id: persona_id ?? null, mode, instruction });
    return res.status(200).json({
      run_id: run._id,
      mode,
      instruction,
      subject: r.data.subject ?? subject ?? '',
      body: r.data.body,
      note: r.data.note?.trim() || null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}
