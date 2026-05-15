import type { VercelRequest, VercelResponse } from '@vercel/node';
// pdf-parse's index.js runs a self-test against a bundled file on require.
// Import the inner module directly to skip that test.
// @ts-expect-error - no types ship for the inner path
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminClient } from '../_lib/supabase';
import { MODEL, createMessageWithRetry, extractJson } from '../_lib/anthropic';
import { PARSE_RESUME_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';

interface ParsedResume {
  headline?: string;
  bio?: string;
  proof_points?: string;
  achievements?: string;
  metrics?: string;
  writing_tone?: string;
  roles?: Array<{
    title?: string;
    organization?: string;
    start?: string;
    end?: string;
    summary?: string;
  }>;
}

const MAX_BYTES = 2 * 1024 * 1024; // 2MB — must match client-side cap
const MAX_TEXT_CHARS = 30_000; // truncate before sending to the LLM to keep prompts bounded

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const { asset_id } = (req.body ?? {}) as { asset_id?: string };
  if (!asset_id) return res.status(400).json({ error: 'asset_id_required' });

  const db = adminClient();
  if (!(await checkRateLimit(db, res, user.id))) return;

  const { data: asset, error: aErr } = await db
    .from('profile_assets')
    .select('*')
    .eq('id', asset_id)
    .eq('user_id', user.id)
    .single();
  if (aErr || !asset) return res.status(404).json({ error: 'asset_not_found' });
  if (asset.kind !== 'resume') {
    return res.status(400).json({ error: 'asset_not_parseable', detail: `Only resume kind is parsed; got ${asset.kind}` });
  }
  if (asset.file_size > MAX_BYTES) {
    return res.status(413).json({ error: 'file_too_large', detail: 'Max 2MB' });
  }

  const run = await startRun(db, {
    user_id: user.id,
    agent_type: 'parse_resume',
    input: { asset_id, file_name: asset.file_name, file_size: asset.file_size },
  });

  try {
    // 1. Download from Storage (service-role bypasses RLS — we already authorized above).
    const { data: blob, error: dlErr } = await db.storage
      .from('profile-assets')
      .download(asset.storage_path);
    if (dlErr || !blob) {
      await failRun(db, run.id, dlErr?.message ?? 'download_failed');
      return res.status(500).json({ error: 'download_failed', detail: dlErr?.message });
    }
    const buf = Buffer.from(await blob.arrayBuffer());

    // 2. Extract text.
    let text = '';
    try {
      const pdf = await pdfParse(buf);
      text = (pdf?.text ?? '').toString().trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'pdf_parse_failed';
      await failRun(db, run.id, msg);
      await db
        .from('profile_assets')
        .update({ parse_error: msg, parsed_at: new Date().toISOString() })
        .eq('id', asset.id);
      return res.status(422).json({ error: 'pdf_parse_failed', detail: msg });
    }

    if (!text || text.length < 50) {
      const msg = 'No text extracted — is the PDF scanned/image-only?';
      await failRun(db, run.id, msg);
      await db
        .from('profile_assets')
        .update({ parsed_text: text, parse_error: msg, parsed_at: new Date().toISOString() })
        .eq('id', asset.id);
      return res.status(422).json({ error: 'pdf_text_empty', detail: msg });
    }

    const truncated = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;

    // 3. LLM structure.
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 2048,
      system: PARSE_RESUME_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `RESUME TEXT:\n\n${truncated}\n\nReturn JSON only.`,
        },
      ],
    });
    const parsed = extractJson<ParsedResume>(message);
    if (!parsed.ok || !parsed.data) {
      await failRun(db, run.id, 'parse_failed');
      await db
        .from('profile_assets')
        .update({
          parsed_text: truncated,
          parse_error: 'LLM did not return valid JSON',
          parsed_at: new Date().toISOString(),
        })
        .eq('id', asset.id);
      return res.status(502).json({ error: 'parse_failed' });
    }

    const cleaned = cleanParsed(parsed.data);

    // 4. Persist parsed_text + parsed_fields on the asset row. Do NOT touch profiles —
    //    the user accepts/declines in the diff modal before any merge happens.
    await db
      .from('profile_assets')
      .update({
        parsed_text: truncated,
        parsed_fields: cleaned as unknown as Record<string, unknown>,
        parse_error: null,
        parsed_at: new Date().toISOString(),
      })
      .eq('id', asset.id);

    await completeRun(db, run.id, {
      asset_id: asset.id,
      text_chars: truncated.length,
      role_count: cleaned.roles?.length ?? 0,
    });

    return res.status(200).json({
      run_id: run.id,
      asset_id: asset.id,
      parsed_fields: cleaned,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    await failRun(db, run.id, msg);
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
