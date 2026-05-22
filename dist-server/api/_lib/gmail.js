// Google Gmail API helpers + OAuth token lifecycle (Mongo edition).
// Token storage moved from Supabase user_integrations table to the Mongo
// `user_integrations` collection. AES-GCM encryption of refresh/access tokens
// is unchanged.
import { adminDb, forUser, newId } from './db';
import { encrypt, decrypt } from './crypto';
import { env } from './env';
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
export function authUrl(state, redirectUri) {
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
export async function exchangeCode(code, redirectUri) {
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
    if (!r.ok)
        throw new Error(`token_exchange_failed: ${await r.text()}`);
    return await r.json();
}
export async function refreshAccessToken(refreshToken) {
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
    if (!r.ok)
        throw new Error(`token_refresh_failed: ${await r.text()}`);
    return await r.json();
}
export async function revokeToken(token) {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' });
}
export async function fetchGoogleUserEmail(accessToken) {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok)
        return null;
    const j = (await r.json());
    return j.email ?? null;
}
/**
 * Upsert the Gmail integration row for a user after a successful OAuth flow.
 * Uses the admin db client (caller has already verified state).
 */
export async function upsertGmailIntegration(args) {
    const db = await adminDb();
    const expiresAt = new Date(Date.now() + args.expiresInSec * 1000);
    const now = new Date();
    await db.collection('user_integrations').updateOne({ userId: args.uid, provider: 'gmail' }, {
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
    }, { upsert: true });
}
/**
 * Get a fresh access token, refreshing if needed. Returns null if not
 * connected or refresh fails.
 */
export async function getActiveAccessToken(uid) {
    const scope = forUser(uid);
    const row = await scope
        .collection('user_integrations')
        .findOne({ provider: 'gmail', status: 'active' });
    if (!row)
        return null;
    if (row.accessTokenEncrypted && row.accessTokenExpiresAt) {
        const expiresMs = new Date(row.accessTokenExpiresAt).getTime();
        if (expiresMs - Date.now() > 60_000) {
            return { accessToken: decrypt(row.accessTokenEncrypted), email: row.providerAccountEmail };
        }
    }
    try {
        const fresh = await refreshAccessToken(decrypt(row.refreshTokenEncrypted));
        const expiresAt = new Date(Date.now() + fresh.expires_in * 1000);
        await scope.collection('user_integrations').updateById(row._id, {
            accessTokenEncrypted: encrypt(fresh.access_token),
            accessTokenExpiresAt: expiresAt,
            lastError: null,
        });
        return { accessToken: fresh.access_token, email: row.providerAccountEmail };
    }
    catch (err) {
        await scope.collection('user_integrations').updateById(row._id, {
            status: 'error',
            lastError: err instanceof Error ? err.message : 'refresh_failed',
        });
        return null;
    }
}
// === Gmail API operations === (unchanged from old implementation)
function buildRfc2822(args) {
    const fromHeader = args.fromName ? `${quoteIfNeeded(args.fromName)} <${args.fromEmail}>` : args.fromEmail;
    const headers = [
        `From: ${fromHeader}`,
        `To: ${args.toEmail}`,
        `Subject: ${encodeRfc2047(args.subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: 7bit',
    ];
    if (args.inReplyTo)
        headers.push(`In-Reply-To: ${args.inReplyTo}`);
    if (args.references)
        headers.push(`References: ${args.references}`);
    const footer = '\r\n\r\n--\r\nTo stop receiving these emails, reply with "UNSUBSCRIBE" in the subject line.';
    return `${headers.join('\r\n')}\r\n\r\n${args.body.replace(/\r?\n/g, '\r\n')}${footer}`;
}
function quoteIfNeeded(s) {
    return /[",<>@]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
function encodeRfc2047(s) {
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(s))
        return s;
    return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}
function base64Url(s) {
    return Buffer.from(s, 'utf8').toString('base64url');
}
export async function createDraft(args) {
    const raw = base64Url(buildRfc2822(args));
    const r = await fetch(`${GMAIL_API}/users/me/drafts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw, threadId: args.threadId } }),
    });
    if (!r.ok)
        throw new Error(`create_draft_failed: ${await r.text()}`);
    const j = (await r.json());
    return { draftId: j.id, messageId: j.message.id, threadId: j.message.threadId ?? '' };
}
export async function sendNow(args) {
    const raw = base64Url(buildRfc2822(args));
    const r = await fetch(`${GMAIL_API}/users/me/messages/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${args.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw, threadId: args.threadId }),
    });
    if (!r.ok)
        throw new Error(`send_failed: ${await r.text()}`);
    const j = (await r.json());
    return { messageId: j.id, threadId: j.threadId };
}
export async function getThread(accessToken, threadId) {
    const r = await fetch(`${GMAIL_API}/users/me/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-Id`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok)
        throw new Error(`get_thread_failed: ${await r.text()}`);
    return await r.json();
}
export async function getMessageFull(accessToken, messageId) {
    const r = await fetch(`${GMAIL_API}/users/me/messages/${messageId}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok)
        throw new Error(`get_message_failed: ${await r.text()}`);
    return (await r.json());
}
export function extractPlainText(payload) {
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
            const nested = extractPlainText(p);
            if (nested)
                return nested;
        }
    }
    return '';
}
export function headerValue(headers, name) {
    if (!headers)
        return null;
    const lower = name.toLowerCase();
    for (const h of headers) {
        if (h.name.toLowerCase() === lower)
            return h.value;
    }
    return null;
}
