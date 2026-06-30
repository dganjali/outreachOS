// Loads the sender's résumé as an email attachment for the send paths
// (api/gmail/send.ts and the scheduled-send cron). The résumé lives as a
// profile_assets doc (kind 'resume') whose bytes are in object storage; we pull
// the most-recent one and stream its bytes in. Returns null when the user has no
// résumé on file, so callers can surface a clear "upload a résumé first" error.

import type { UserScope } from './db';
import { downloadObject } from './storage';
import type { MailAttachment } from './gmail';
import type { ProfileAssetDoc } from '../../shared/schemas';

// Gmail's raw send tops out around 35MB after base64 (~33% inflation), and the
// uploader already caps assets at 20MB. Guard here too so a stray large file
// can't blow up the send request.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** The user's latest résumé asset, or null if none is on file. */
export async function findResumeAsset(scope: UserScope): Promise<ProfileAssetDoc | null> {
  const [asset] = await scope
    .collection<ProfileAssetDoc>('profile_assets')
    .find({ kind: 'resume' } as Partial<ProfileAssetDoc>, { sort: { createdAt: -1 }, limit: 1 });
  return (asset as ProfileAssetDoc) ?? null;
}

/** True if the user has at least one résumé asset (cheap existence check). */
export async function hasResume(scope: UserScope): Promise<boolean> {
  return (await findResumeAsset(scope)) !== null;
}

/** Load a profile asset's bytes as a `MailAttachment`. Throws only on a real
 *  storage failure or an over-size file; returns the attachment otherwise. */
async function assetToAttachment(asset: ProfileAssetDoc): Promise<MailAttachment> {
  const content = await downloadObject(asset.storagePath);
  if (content.length > MAX_ATTACHMENT_BYTES) {
    throw new Error('attachment_too_large');
  }
  return {
    filename: asset.fileName || 'attachment',
    mimeType: asset.mimeType || 'application/octet-stream',
    content,
  };
}

/**
 * Load the sender's résumé as a `MailAttachment`, or null when none exists.
 * Throws only on a real storage failure (so the caller fails the send loudly
 * rather than silently dropping the attachment the user asked for).
 */
export async function getResumeAttachment(scope: UserScope): Promise<MailAttachment | null> {
  const asset = await findResumeAsset(scope);
  if (!asset) return null;
  const att = await assetToAttachment(asset);
  return { ...att, filename: asset.fileName || 'resume.pdf', mimeType: asset.mimeType || 'application/pdf' };
}

/**
 * Load an arbitrary profile asset (by id) as a `MailAttachment`. Used for the
 * mission-level "attach to every email" file. Returns null when the asset no
 * longer exists, so a deleted attachment degrades to "send without it" rather
 * than blocking the send. Re-resolves storagePath at call time, which is what
 * lets the scheduled-send cron load the right bytes at actual send time.
 */
export async function getAssetAttachment(scope: UserScope, assetId: string): Promise<MailAttachment | null> {
  const asset = await scope.collection<ProfileAssetDoc>('profile_assets').findById(assetId);
  if (!asset) return null;
  return assetToAttachment(asset);
}
