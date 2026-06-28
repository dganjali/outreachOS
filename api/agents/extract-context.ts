// extract-context agent - context-dump / file-dump smart fill.
//
// Accepts either:
//   • text  - a pasted blob (bio, LinkedIn copy-paste, etc.)
//   • asset_id - a previously uploaded profile asset (PDF, DOCX, TXT, MD, RTF)
// Exactly one of the two must be supplied.
//
// Destination (where the extracted facts live):
//   • 'person'  - the durable memory bank, reused by every mission (default).
//   • 'mission' - this campaign's substance, scoped to `mission_id`.
// The agent classifies the document (personal vs offer/pitch) and, when the
// caller doesn't pin a destination, AUTO-ROUTES: an offer/pitch doc goes to the
// mission (if a mission_id is present), everything else to the memory bank. The
// caller can override by passing `destination` explicitly (e.g. keep a one-off
// doc mission-only). The chosen scope + document_kind are returned so the UI can
// surface the suggestion and let the user flip it.

import type { Request, Response } from 'express';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId, type InsertDoc } from '../_lib/db';
import { downloadObject } from '../_lib/storage';
import { generateJson, MODEL } from '../_lib/llm';
import { EXTRACT_CONTEXT_SYSTEM } from '../_lib/prompts';
import { embedOne } from '../_lib/embeddings';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { extractText } from '../_lib/file-extract';
import type { ContextFactDoc, MissionDoc, ProfileAssetDoc } from '../../shared/schemas';

const MAX_TEXT_CHARS = 30_000;

// Whole-document classification used to suggest a destination.
//   personal = about the sender (bio/resume/credentials) → memory bank.
//   offer    = a pitch/offering doc (sponsorship, rate card, proposal) → mission.
//   mixed    = both; defaults to memory bank unless caller pins it.
type DocumentKind = 'personal' | 'offer' | 'mixed';

// ---------------------------------------------------------------------------
// Gemini flat schema - no recursion, no $ref, no allOf.
// ---------------------------------------------------------------------------
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    document_kind: { type: 'string', enum: ['personal', 'offer', 'mixed'] },
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
  document_kind?: DocumentKind;
  facts: ExtractedFact[];
}

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { asset_id, text, mission_id, destination } = (req.body ?? {}) as {
    asset_id?: string;
    text?: string;
    mission_id?: string;
    destination?: 'person' | 'mission';
  };

  if (!asset_id && !text) {
    return res.status(400).json({ error: 'asset_id_or_text_required' });
  }
  if (destination === 'mission' && !mission_id) {
    return res.status(400).json({ error: 'mission_id_required_for_mission_destination' });
  }

  // Verify mission ownership up front when one is referenced (ownership rides on
  // the forUser scope, so a missing doc means it isn't theirs).
  if (mission_id) {
    const mission = await scope.collection<MissionDoc>('missions').findById(mission_id);
    if (!mission) return res.status(404).json({ error: 'mission_not_found' });
  }

  if (!(await checkRateLimit(scope, res))) return;

  const run = await startRun(scope, {
    agentType: 'extract_context',
    input: { asset_id: asset_id ?? null, has_text: Boolean(text), mission_id: mission_id ?? null, destination: destination ?? 'auto' },
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
    const userPrompt = `CONTEXT DUMP:\n\n${rawText}\n\nExtract up to 25 atomic facts. Cover BOTH who the sender is AND what they offer (deliverables, benefits, tiers, audience) - if this is a sponsorship/partnership/offering document, the benefits and audience facts are the most important.\n\nAlso set "document_kind" for the document AS A WHOLE: "personal" if it is about the sender (bio, resume, LinkedIn, credentials), "offer" if it is a pitch/offering document (sponsorship package, partnership deck, one-pager, rate card, prospectus, proposal), or "mixed" if it is substantially both. JSON only.`;

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
    const documentKind: DocumentKind = r.data.document_kind ?? 'personal';

    // ---- 3. Decide where the facts land ------------------------------------
    // Explicit destination wins; otherwise auto-route by document kind (an
    // offer/pitch doc → the mission, everything else → the memory bank).
    const finalScope: 'person' | 'mission' =
      destination === 'mission'
        ? 'mission'
        : destination === 'person'
          ? 'person'
          : documentKind === 'offer' && mission_id
            ? 'mission'
            : 'person';
    const finalMissionId = finalScope === 'mission' ? mission_id! : null;

    // ---- 4. De-dupe against existing facts in the SAME bank ----------------
    const existing = await scope.collection<ContextFactDoc>('context_facts').find(
      (finalScope === 'mission'
        ? { scope: 'mission', missionId: finalMissionId }
        : { scope: 'person' }) as Record<string, unknown>
    );
    const existingClaims = new Set(existing.map((f) => f.claim.toLowerCase().trim()));

    const toInsert = extracted.filter((f) => !existingClaims.has(f.claim.toLowerCase().trim()));

    // ---- 5. Persist, with best-effort embeddings ---------------------------
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
        scope: finalScope,
        missionId: finalMissionId,
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
      document_kind: documentKind,
      scope: finalScope,
    });

    return res.status(200).json({
      run_id: run._id,
      facts: inserted,
      document_kind: documentKind,
      scope: finalScope,
      mission_id: finalMissionId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed' });
  }
}
