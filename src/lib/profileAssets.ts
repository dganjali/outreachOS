import { supabase } from '../supabaseClient';
import type { ProfileAsset, ProfileAssetKind } from '../types';

const BUCKET = 'profile-assets';
export const MAX_ASSET_BYTES = 2 * 1024 * 1024; // 2MB — must match server-side cap in parse-resume.ts

const ACCEPTED_MIME: Record<ProfileAssetKind, string[]> = {
  resume: ['application/pdf'],
  portfolio_pdf: ['application/pdf'],
  case_study: ['application/pdf'],
  screenshot: ['image/png', 'image/jpeg', 'image/webp'],
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
}): Promise<ProfileAsset> {
  const { userId, kind, file } = opts;

  if (file.size > MAX_ASSET_BYTES) {
    throw new Error(`File too large. Max 2MB; this file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
  }
  const accepted = ACCEPTED_MIME[kind];
  if (file.type && !accepted.includes(file.type)) {
    throw new Error(`Unsupported file type for ${kind}. Accepted: ${accepted.join(', ')}.`);
  }

  const ext = safeExtension(file.name, file.type);
  // Path hint — the server will derive the real GCS path from `kind` (in this
  // hint) and ignore the rest. We read the actual path back from upload().
  const pathHint = `${userId}/${kind}/${randomSegment()}.${ext}`;
  const { data: uploaded, error: upErr } = await supabase.storage.from(BUCKET).upload(pathHint, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr || !uploaded) throw new Error(upErr?.message ?? 'upload_failed');

  // Use the path the server actually stored at — not the client-side hint.
  const storedPath = uploaded.path;

  const { data: row, error: insErr } = await supabase
    .from('profile_assets')
    .insert({
      user_id: userId,
      kind,
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
  // If the storage delete fails (already gone), continue — the row is the source of truth in the UI.
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
