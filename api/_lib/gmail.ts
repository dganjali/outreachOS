import { adminClient } from './supabase';
import { encrypt, decrypt } from './crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export function authUrl(state: string, redirectUri: string): string {
  const clientId = required('GOOGLE_CLIENT_ID');
  const params = new URLSearchParams({
    client_id: clientId,
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
  const clientId = required('GOOGLE_CLIENT_ID');
  const clientSecret = required('GOOGLE_CLIENT_SECRET');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!r.ok) throw new Error(`token_exchange_failed: ${await r.text()}`);
  return (await r.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const clientId = required('GOOGLE_CLIENT_ID');
  const clientSecret = required('GOOGLE_CLIENT_SECRET');
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!r.ok) throw new Error(`token_refresh_failed: ${await r.text()}`);
  return (await r.json()) as { access_token: string; expires_in: number };
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

interface IntegrationRow {
  id: string;
  user_id: string;
  provider: string;
  provider_account_email: string | null;
  refresh_token_encrypted: string;
  access_token_encrypted: string | null;
  access_token_expires_at: string | null;
  status: string;
}

export async function getActiveAccessToken(userId: string): Promise<{ accessToken: string; email: string | null } | null> {
  const db = adminClient();
  const { data, error } = await db
    .from('user_integrations')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'gmail')
    .eq('status', 'active')
    .maybeSingle();
  if (error || !data) return null;
  const row = data as IntegrationRow;

  // Reuse existing access token if it's not expired in the next 60s
  if (row.access_token_encrypted && row.access_token_expires_at) {
    const expiresMs = new Date(row.access_token_expires_at).getTime();
    if (expiresMs - Date.now() > 60_000) {
      return {
        accessToken: decrypt(row.access_token_encrypted),
        email: row.provider_account_email,
      };
    }
  }

  // Refresh
  try {
    const refresh = decrypt(row.refresh_token_encrypted);
    const fresh = await refreshAccessToken(refresh);
    const expiresAt = new Date(Date.now() + fresh.expires_in * 1000).toISOString();
    await db
      .from('user_integrations')
      .update({
        access_token_encrypted: encrypt(fresh.access_token),
        access_token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', row.id);
    return { accessToken: fresh.access_token, email: row.provider_account_email };
  } catch (err) {
    await db
      .from('user_integrations')
      .update({
        status: 'error',
        last_error: err instanceof Error ? err.message : 'refresh_failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    return null;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// === Gmail API operations ===

function buildRfc2822({
  fromEmail,
  fromName,
  toEmail,
  subject,
  body,
  inReplyTo,
  references,
}: {
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const fromHeader = fromName ? `${quoteIfNeeded(fromName)} <${fromEmail}>` : fromEmail;
  const headers: string[] = [
    `From: ${fromHeader}`,
    `To: ${toEmail}`,
    `Subject: ${encodeRfc2047(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  return `${headers.join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}`;
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
    body: JSON.stringify({
      message: { raw, threadId: args.threadId },
    }),
  });
  if (!r.ok) throw new Error(`create_draft_failed: ${await r.text()}`);
  const j = (await r.json()) as { id: string; message: { id: string; threadId: string } };
  return { draftId: j.id, messageId: j.message.id, threadId: j.message.threadId };
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
  payload?: {
    headers: Array<{ name: string; value: string }>;
  };
  snippet?: string;
}

export async function getThread(accessToken: string, threadId: string): Promise<{ messages: GmailMessageMeta[] }> {
  const r = await fetch(`${GMAIL_API}/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-Id`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`get_thread_failed: ${await r.text()}`);
  return (await r.json()) as { messages: GmailMessageMeta[] };
}

export async function getMessageFull(accessToken: string, messageId: string): Promise<{
  id: string;
  threadId: string;
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string; size: number };
    parts?: Array<{ mimeType: string; body?: { data?: string }; parts?: unknown[] }>;
  };
}> {
  const r = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`get_message_failed: ${await r.text()}`);
  return await r.json();
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
    // fall back to nested
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
