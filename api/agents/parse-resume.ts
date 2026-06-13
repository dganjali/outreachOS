import type { Request, Response } from 'express';
// pdf-parse's index.js runs a self-test against a bundled file on require.
// Import the inner module directly to skip that test.
// @ts-expect-error - no types ship for the inner path
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { downloadObject } from '../_lib/storage';
import { MODEL, createMessageWithRetry, extractJson } from '../_lib/llm';
import { PARSE_RESUME_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import type { ProfileAssetDoc } from '../../shared/schemas';

interface ParsedResume {
  headline?: string;
  bio?: string;
  proof_points?: string;
  achievements?: string;
  metrics?: string;
  writing_tone?: string;
  roles?: Array<{ title?: string; organization?: string; start?: string; end?: string; summary?: string }>;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 30_000;

export default async function handler(req: Request, res: Response) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;
  const scope = forUser(user.id);

  const { asset_id } = (req.body ?? {}) as { asset_id?: string };
  if (!asset_id) return res.status(400).json({ error: 'asset_id_required' });

  if (!(await checkRateLimit(scope, res))) return;

  const asset = await scope.collection<ProfileAssetDoc>('profile_assets').findById(asset_id);
  if (!asset) return res.status(404).json({ error: 'asset_not_found' });
  if (asset.kind !== 'resume') {
    return res.status(400).json({ error: 'asset_not_parseable', detail: `Only resume kind is parsed; got ${asset.kind}` });
  }
  if (asset.fileSize > MAX_BYTES) {
    return res.status(413).json({ error: 'file_too_large', detail: 'Max 2MB' });
  }

  const run = await startRun(scope, {
    agentType: 'parse_resume',
    input: { asset_id, file_name: asset.fileName, file_size: asset.fileSize },
  });

  try {
    // 1. Download from Cloud Storage.
    let buf: Buffer;
    try {
      buf = await downloadObject(asset.storagePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'download_failed';
      await failRun(scope, run._id, msg);
      return res.status(500).json({ error: 'download_failed', detail: msg });
    }

    // 2. Extract text.
    let text = '';
    try {
      const pdf = await pdfParse(buf);
      text = (pdf?.text ?? '').toString().trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'pdf_parse_failed';
      await failRun(scope, run._id, msg);
      await scope.collection<ProfileAssetDoc>('profile_assets').updateById(asset._id, {
        parseError: msg,
        parsedAt: new Date(),
      });
      return res.status(422).json({ error: 'pdf_parse_failed', detail: msg });
    }

    if (!text || text.length < 50) {
      const msg = 'No text extracted — is the PDF scanned/image-only?';
      await failRun(scope, run._id, msg);
      await scope.collection<ProfileAssetDoc>('profile_assets').updateById(asset._id, {
        parsedText: text,
        parseError: msg,
        parsedAt: new Date(),
      });
      return res.status(422).json({ error: 'pdf_text_empty', detail: msg });
    }

    const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

    // 3. LLM structure.
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 2048,
      system: PARSE_RESUME_SYSTEM,
      messages: [{ role: 'user', content: `RESUME TEXT:\n\n${truncated}\n\nReturn JSON only.` }],
    });
    const parsed = extractJson<ParsedResume>(message);
    if (!parsed.ok || !parsed.data) {
      await failRun(scope, run._id, 'parse_failed');
      await scope.collection<ProfileAssetDoc>('profile_assets').updateById(asset._id, {
        parsedText: truncated,
        parseError: 'LLM did not return valid JSON',
        parsedAt: new Date(),
      });
      return res.status(502).json({ error: 'parse_failed' });
    }

    const cleaned = cleanParsed(parsed.data);

    await scope.collection<ProfileAssetDoc>('profile_assets').updateById(asset._id, {
      parsedText: truncated,
      parsedFields: cleaned as unknown as Record<string, unknown>,
      parseError: null,
      parsedAt: new Date(),
    });

    await completeRun(scope, run._id, {
      asset_id: asset._id,
      text_chars: truncated.length,
      role_count: cleaned.roles?.length ?? 0,
    });

    return res.status(200).json({
      run_id: run._id,
      asset_id: asset._id,
      parsed_fields: cleaned,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(scope, run._id, msg);
    return res.status(500).json({ error: 'agent_failed', detail: msg });
  }
}

function cleanParsed(p: ParsedResume): ParsedResume {
  const trimStr = (s: unknown, cap = 2000): string =>
    typeof s === 'string' ? s.trim().slice(0, cap) : '';
  return {
    headline: trimStr(p.headline, 200),
    bio: trimStr(p.bio, 1200),
    proof_points: trimStr(p.proof_points, 2000),
    achievements: trimStr(p.achievements, 2000),
    metrics: trimStr(p.metrics, 2000),
    writing_tone: trimStr(p.writing_tone, 200),
    roles: Array.isArray(p.roles)
      ? p.roles
          .slice(0, 12)
          .map((r) => ({
            title: trimStr(r?.title, 150),
            organization: trimStr(r?.organization, 150),
            start: trimStr(r?.start, 50),
            end: trimStr(r?.end, 50),
            summary: trimStr(r?.summary, 600),
          }))
          .filter((r) => r.title || r.organization)
      : [],
  };
}
