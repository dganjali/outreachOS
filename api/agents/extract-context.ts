// extract-context agent - context-dump / file-dump smart fill for
// "What makes you worth a reply?" (SubstanceStep).
//
// Accepts either:
//   • text  - a pasted blob (bio, LinkedIn copy-paste, etc.)
//   • asset_id - a previously uploaded profile asset (PDF, DOCX, TXT, MD, RTF)
// Exactly one of the two must be supplied.
//
// Extracted facts are persisted PERSON-LEVEL so they survive across every voice
// and show up in ME → Context. They are NOT re-inserted by ensurePersona.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { downloadObject } from '../_lib/storage';
import { generateJson, MODEL } from '../_lib/llm';
import { EXTRACT_CONTEXT_SYSTEM } from '../_lib/prompts';
import { embedOne } from '../_lib/embeddings';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { extractText } from '../_lib/file-extract';
import type { ContextFactDoc, ProfileAssetDoc } from '../../shared/schemas';

const MAX_TEXT_CHARS = 30_000;

// ---------------------------------------------------------------------------
// Gemini flat schema - no recursion, no $ref, no allOf.
// ---------------------------------------------------------------------------
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['proof', 'metric', 'offer', 'audience', 'credential', 'constraint'],
          },
          claim: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['type', 'claim'],
      },
    },
  },
  required: ['facts'],
} as const;

interface ExtractedFact {
  type: ContextFactDoc['type'];
  claim: string;
  date?: string;
}

interface FactsOut {
  facts: ExtractedFact[];
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { asset_id, text, persona_id } = (req.body ?? {}) as {
    asset_id?: string;
    text?: string;
    persona_id?: string;
  };

  if (!asset_id && !text) {
    return res.status(400).json({ error: 'asset_id_or_text_required' });
  }

  if (!(await checkRateLimit(scope, res))) return;

  const run = await startRun(scope, {
    agentType: 'extract_context',
    input: { asset_id: asset_id ?? null, has_text: Boolean(text), persona_id: persona_id ?? null },
  });

  try {
    // ---- 1. Resolve raw text ------------------------------------------------
    let rawText: string;
    let provenance: ContextFactDoc['provenance'];

    if (text) {
      rawText = text.slice(0, MAX_TEXT_CHARS);
      provenance = 'dictation';
    } else {
      // Load asset and verify ownership via forUser scope.
      const asset = await scope.collection<ProfileAssetDoc>('profile_assets').findById(asset_id!);
      if (!asset) {
        await failRun(scope, run._id, 'asset_not_found');
        return res.status(404).json({ error: 'asset_not_found' });
      }

      let buf: Buffer;
      try {
        buf = await downloadObject(asset.storagePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'download_failed';
        await failRun(scope, run._id, msg);
        return res.status(500).json({ error: 'download_failed' });
      }

      try {
        rawText = await extractText(buf, asset.mimeType, asset.fileName);
        rawText = rawText.slice(0, MAX_TEXT_CHARS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'extract_failed';
        const code = (err as { code?: string }).code ?? 'extract_failed';
        await failRun(scope, run._id, msg);
        return res.status(422).json({ error: code, detail: msg });
      }

      provenance = 'resume';
    }

    // ---- 2. Extract facts via LLM -------------------------------------------
    const userPrompt = `CONTEXT DUMP:\n\n${rawText}\n\nExtract up to 25 atomic facts. Cover BOTH who the sender is AND what they offer (deliverables, benefits, tiers, audience) - if this is a sponsorship/partnership/offering document, the benefits and audience facts are the most important. JSON only.`;

    const r = await generateJson<FactsOut>({
      model: MODEL(),
      max_tokens: 2048,
      temperature: 0.2,
      system: EXTRACT_CONTEXT_SYSTEM,
      responseJsonSchema: FACTS_SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });

    if (!r.ok || !Array.isArray(r.data?.facts)) {
      await failRun(scope, run._id, 'parse_failed');
      return res.status(502).json({ error: 'parse_failed', raw: r.raw.slice(0, 500) });
    }

    const extracted = r.data.facts.filter((f) => f.claim?.trim()).slice(0, 25);

    // ---- 3. De-dupe against existing person-level facts ---------------------
    const existing = await scope.collection<ContextFactDoc>('context_facts').find({
      scope: 'person',
    } as Record<string, unknown>);
    const existingClaims = new Set(existing.map((f) => f.claim.toLowerCase().trim()));

    const toInsert = extracted.filter((f) => !existingClaims.has(f.claim.toLowerCase().trim()));

    // ---- 4. Persist person-level, with best-effort embeddings ---------------
    const inserted: Array<{ id: string; claim: string; type: string }> = [];
    for (const f of toInsert) {
      let embedding: number[] | undefined;
      try {
        embedding = await embedOne(f.claim, 'document');
      } catch {
        // Best-effort - skip on failure; facts are still useful without vectors.
      }

      const doc: InsertDoc<ContextFactDoc> = {
        _id: newId(),
        scope: 'person',
        personaId: null,
        type: f.type,
        claim: f.claim.trim(),
        date: f.date ?? null,
        evidenceUrl: null,
        provenance,
        confidence: provenance === 'resume' ? 0.75 : 0.65,
        ...(embedding ? { embedding } : {}),
      };

      const saved = await scope.collection<ContextFactDoc>('context_facts').insertOne(doc);
      inserted.push({ id: saved._id as string, claim: f.claim.trim(), type: f.type });
    }

    await completeRun(scope, run._id, {
      inserted_count: inserted.length,
      deduped_count: extracted.length - inserted.length,
      provenance,
    });

    return res.status(200).json({
      run_id: run._id,
      facts: inserted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}
