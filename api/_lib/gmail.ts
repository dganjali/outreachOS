// Google Gmail API helpers + OAuth token lifecycle (Mongo edition).
// Token storage moved from Supabase user_integrations table to the Mongo
// `user_integrations` collection. AES-GCM encryption of refresh/access tokens
// is unchanged.

import { adminDb, forUser, newId } from './db';
import { encrypt, decrypt } from './crypto';
import { env } from './env';
import type { UserIntegrationDoc } from '../../shared/schemas';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// gmail.send is the ONLY Gmail scope in Google's "sensitive" tier (no CASA).
// Everything else that touches the mailbox — readonly, modify, and even
// compose (it manages draft content) — is "restricted" and triggers a paid
// annual security assessment. So we send only; "drafts" are stored in-app and
// never pushed to the user's Gmail.
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export function authUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number; scope: string }> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID(),
      client_secret: env.GOOGLE_CLIENT_SECRET(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!r.ok) throw new Error(`token_exchange_failed: ${await r.text()}`);
  return await r.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID(),
      client_secret: env.GOOGLE_CLIENT_SECRET(),
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`token_refresh_failed: ${await r.text()}`);
  return await r.json();
}

export async function revokeToken(token: string) {
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
}

export async function fetchGoogleUserEmail(accessToken: string): Promise<string | null> {
  const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { email?: string };
  return j.email ?? null;
}

/**
 * Upsert the Gmail integration row for a user after a successful OAuth flow.
 * Uses the admin db client (caller has already verified state).
 */
export async function upsertGmailIntegration(args: {
  uid: string;
  email: string | null;
  refreshToken: string;
  accessToken: string;
  expiresInSec: number;
  scopes: string;
}): Promise<void> {
  const db = await adminDb();
  const expiresAt = new Date(Date.now() + args.expiresInSec * 1000);
  const now = new Date();
  await db.collection<UserIntegrationDoc>('user_integrations').updateOne(
    { userId: args.uid, provider: 'gmail' },
    {
      $set: {
        providerAccountEmail: args.email,
        refreshTokenEncrypted: encrypt(args.refreshToken),
        accessTokenEncrypted: encrypt(args.accessToken),
        accessTokenExpiresAt: expiresAt,
        scopes: args.scopes,
        status: 'active',
        lastError: null,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: newId(),
        userId: args.uid,
        provider: 'gmail',
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

/**
 * Get a fresh access token, refreshing if needed. Returns null if not
 * connected or refresh fails.
 */
export async function getActiveAccessToken(uid: string): Promise<{ accessToken: string; email: string | null } | null> {
  const scope = forUser(uid);
  const row = await scope
    .collection<UserIntegrationDoc>('user_integrations')
    .findOne({ provider: 'gmail', status: 'active' });
  if (!row) return null;

  if (row.accessTokenEncrypted && row.accessTokenExpiresAt) {
    const expiresMs = new Date(row.accessTokenExpiresAt).getTime();
    if (expiresMs - Date.now() > 60_000) {
      return { accessToken: decrypt(row.accessTokenEncrypted), email: row.providerAccountEmail };
    }
  }

  try {
    const fresh = await refreshAccessToken(decrypt(row.refreshTokenEncrypted));
    const expiresAt = new Date(Date.now() + fresh.expires_in * 1000);
    await scope.collection<UserIntegrationDoc>('user_integrations').updateById(row._id, {
      accessTokenEncrypted: encrypt(fresh.access_token),
      accessTokenExpiresAt: expiresAt,
      lastError: null,
    });
    return { accessToken: fresh.access_token, email: row.providerAccountEmail };
  } catch (err) {
    await scope.collection<UserIntegrationDoc>('user_integrations').updateById(row._id, {
      status: 'error',
      lastError: err instanceof Error ? err.message : 'refresh_failed',
    });
    return null;
  }
}

// === Gmail API operations === (unchanged from old implementation)

function buildRfc2822(args: {
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const fromHeader = args.fromName ? `${quoteIfNeeded(args.fromName)} <${args.fromEmail}>` : args.fromEmail;
  const headers: string[] = [
    `From: ${fromHeader}`,
    `To: ${args.toEmail}`,
    `Subject: ${encodeRfc2047(args.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);
  const footer = '\r\n\r\n--\r\nTo stop receiving these emails, reply with "UNSUBSCRIBE" in the subject line.';
  return `${headers.join('\r\n')}\r\n\r\n${args.body.replace(/\r?\n/g, '\r\n')}${footer}`;
}

function quoteIfNeeded(s: string): string {
  return /[",<>@]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

function encodeRfc2047(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

function base64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

interface SendArgs {
  accessToken: string;
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}

export async function createDraft(args: SendArgs): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const raw = base64Url(buildRfc2822(args));
  const r = await fetch(`${GMAIL_API}/users/me/drafts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw, threadId: args.threadId } }),
  });
  if (!r.ok) throw new Error(`create_draft_failed: ${await r.text()}`);
  const j = (await r.json()) as { id: string; message: { id: string; threadId: string | null } };
  return { draftId: j.id, messageId: j.message.id, threadId: j.message.threadId ?? '' };
}

export async function sendNow(args: SendArgs): Promise<{ messageId: string; threadId: string }> {
  const raw = base64Url(buildRfc2822(args));
  const r = await fetch(`${GMAIL_API}/users/me/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, threadId: args.threadId }),
  });
  if (!r.ok) throw new Error(`send_failed: ${await r.text()}`);
  const j = (await r.json()) as { id: string; threadId: string };
  return { messageId: j.id, threadId: j.threadId };
}

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  internalDate: string;
  payload?: { headers: Array<{ name: string; value: string }> };
  snippet?: string;
}

export async function getThread(accessToken: string, threadId: string): Promise<{ messages: GmailMessageMeta[] }> {
  const r = await fetch(
    `${GMAIL_API}/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-Id`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok) throw new Error(`get_thread_failed: ${await r.text()}`);
  return await r.json();
}

export async function getMessageFull(accessToken: string, messageId: string) {
  const r = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`get_message_failed: ${await r.text()}`);
  return (await r.json()) as {
    id: string;
    threadId: string;
    snippet: string;
    payload: {
      headers: Array<{ name: string; value: string }>;
      body?: { data?: string; size: number };
      parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: unknown[] }>;
    };
  };
}

export function extractPlainText(payload: {
  body?: { data?: string };
  parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: unknown[] }>;
}): string {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      if (p.mimeType === 'text/plain' && p.body?.data) {
        return Buffer.from(p.body.data, 'base64').toString('utf8');
      }
    }
    for (const p of payload.parts) {
      const nested = extractPlainText(p as { body?: { data?: string }; parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: unknown[] }> });
      if (nested) return nested;
    }
  }
  return '';
}

export function headerValue(headers: Array<{ name: string; value: string }> | undefined, name: string): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return null;
}
