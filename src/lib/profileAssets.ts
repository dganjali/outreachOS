import { supabase } from '../supabaseClient';
import type { ProfileAsset, ProfileAssetKind } from '../types';

const BUCKET = 'profile-assets';
export const MAX_ASSET_BYTES = 20 * 1024 * 1024; // 20MB - must match server-side cap in parse-resume.ts

// Server-side OCR (Gemini inline data) caps the raw file at 14MB - base64
// inflation (~33%) would otherwise push the request past Vertex's ~20MB limit.
// So any image larger than this can't be OCR'd as-is. We recompress in the
// browser before upload to land comfortably under the cap; `OCR_TARGET_BYTES`
// is the size we aim for (well below 14MB, leaving headroom for base64).
const OCR_TARGET_BYTES = 9 * 1024 * 1024;
// Longest edge we keep when recompressing - high enough that OCR text stays
// crisp, low enough to shrink oversized phone screenshots/photos.
const MAX_IMAGE_EDGE = 4000;

const ACCEPTED_MIME: Record<ProfileAssetKind, string[]> = {
  resume: ['application/pdf'],
  portfolio_pdf: ['application/pdf'],
  case_study: ['application/pdf'],
  screenshot: ['image/png', 'image/jpeg', 'image/webp'],
  // A pure email attachment (deck, one-pager, résumé copy) sent with every email
  // in a mission. Accept the common document/image types a recipient can open.
  mission_attachment: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'image/png',
    'image/jpeg',
    'image/webp',
  ],
  // context_dump accepts PDF, DOCX, TXT, MD, RTF. Note: .md and .rtf files
  // often have an empty file.type - the existing `if (file.type && ...)` guard
  // already lets empty types through, so extension-only detection works fine.
  context_dump: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'text/rtf',
    'application/rtf',
    // Images / screenshots - extracted via OCR (Gemini) server-side.
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/heic',
    'image/heif',
  ],
};

function randomSegment(): string {
  // RFC 4122 v4 if available; fallback to a timestamp + random.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeExtension(name: string, mime: string): string {
  const dot = name.lastIndexOf('.');
  if (dot !== -1 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Recompress an oversized image so server-side OCR (which caps inline data at
 * 14MB) can read it. Returns the original file untouched when it's not a
 * canvas-decodable raster, is already small enough, or can't be decoded (e.g.
 * HEIC, which browsers can't draw - the server then surfaces a clear size error).
 *
 * Downscales the longest edge to `MAX_IMAGE_EDGE` and re-encodes as JPEG,
 * stepping quality down until the result fits `OCR_TARGET_BYTES`. Text stays
 * legible at these settings; a 15MB PNG screenshot lands around ~1MB.
 */
async function downscaleImageForOcr(file: File): Promise<File> {
  // Detect images by MIME *or* extension - screenshots often arrive with an
  // empty file.type, which a MIME-only check would miss.
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const looksLikeImage =
    /^image\//.test(file.type) || ['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', 'bmp', 'gif'].includes(ext);
  if (!looksLikeImage || file.size <= OCR_TARGET_BYTES) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // Undecodable (e.g. HEIC) - let the server report the size issue.
  }

  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);

    let quality = 0.9;
    let blob = await canvasToBlob(canvas, quality);
    while (blob && blob.size > OCR_TARGET_BYTES && quality > 0.5) {
      quality -= 0.1;
      blob = await canvasToBlob(canvas, quality);
    }
    if (!blob || blob.size >= file.size) return file; // No win - keep original.

    const baseName = file.name.replace(/\.[^./\\]+$/, '');
    return new File([blob], `${baseName}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } finally {
    bitmap.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

export async function listAssets(userId: string): Promise<ProfileAsset[]> {
  const { data, error } = await supabase
    .from('profile_assets')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProfileAsset[];
}

export async function uploadAsset(opts: {
  userId: string;
  kind: ProfileAssetKind;
  file: File;
  // Where the asset lives: 'person' (memory bank, default) or 'mission'. When
  // 'mission', pass the missionId it attaches to.
  scope?: 'person' | 'mission';
  missionId?: string | null;
}): Promise<ProfileAsset> {
  const { userId, kind } = opts;
  const assetScope = opts.scope ?? 'person';
  const missionId = assetScope === 'mission' ? opts.missionId ?? null : null;
  // Oversized images are recompressed so server-side OCR can read them; other
  // file types pass through unchanged.
  const file = await downscaleImageForOcr(opts.file);

  if (file.size > MAX_ASSET_BYTES) {
    throw new Error(`File too large. Max 20MB; this file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
  }
  const accepted = ACCEPTED_MIME[kind];
  if (file.type && !accepted.includes(file.type)) {
    throw new Error(`Unsupported file type for ${kind}. Accepted: ${accepted.join(', ')}.`);
  }

  const ext = safeExtension(file.name, file.type);
  // Path hint - the server will derive the real GCS path from `kind` (in this
  // hint) and ignore the rest. We read the actual path back from upload().
  const pathHint = `${userId}/${kind}/${randomSegment()}.${ext}`;
  const { data: uploaded, error: upErr } = await supabase.storage.from(BUCKET).upload(pathHint, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr || !uploaded) throw new Error(upErr?.message ?? 'upload_failed');

  // Use the path the server actually stored at - not the client-side hint.
  const storedPath = uploaded.path;

  const { data: row, error: insErr } = await supabase
    .from('profile_assets')
    .insert({
      user_id: userId,
      kind,
      scope: assetScope,
      mission_id: missionId,
      storage_path: storedPath,
      file_name: file.name.slice(0, 200),
      file_size: file.size,
      mime_type: file.type || null,
    })
    .select('*')
    .single();
  if (insErr || !row) {
    // Best-effort cleanup of the orphaned object.
    await supabase.storage.from(BUCKET).remove([storedPath]).catch(() => undefined);
    throw new Error(insErr?.message ?? 'asset_insert_failed');
  }
  return row as ProfileAsset;
}

export async function deleteAsset(asset: ProfileAsset): Promise<void> {
  // Remove storage object first; if the row delete fails, the user can retry.
  // If the storage delete fails (already gone), continue - the row is the source of truth in the UI.
  await supabase.storage.from(BUCKET).remove([asset.storage_path]).catch(() => undefined);
  const { error } = await supabase.from('profile_assets').delete().eq('id', asset.id);
  if (error) throw new Error(error.message);
}

export async function signedAssetUrl(asset: ProfileAsset, expiresInSec = 600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(asset.storage_path, expiresInSec);
  if (error || !data) return null;
  return data.signedUrl;
}
