// Gmail reply poller. Called by Cloud Scheduler (replaces Vercel cron).
//
// Auth: Cloud Scheduler sends `Authorization: Bearer ${CRON_SECRET}`.
import { adminDb, newId } from '../_lib/db';
import { getActiveAccessToken, getThread, getMessageFull, extractPlainText, headerValue, } from '../_lib/gmail';
import { requireCronSecret } from '../_lib/auth';
export default async function handler(req, res) {
    if (!requireCronSecret(req, res))
        return;
    const db = await adminDb();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const userRows = await db
        .collection('user_integrations')
        .find({ provider: 'gmail', status: 'active' })
        .toArray();
    const userIds = userRows.map((u) => u.userId);
    if (userIds.length === 0)
        return res.status(200).json({ checked: 0 });
    const errors = [];
    let totalScanned = 0;
    let totalInserted = 0;
    async function processUser(userId) {
        let scanned = 0;
        let inserted = 0;
        try {
            const threads = await db
                .collection('sent_messages')
                .find({
                userId,
                status: 'sent',
                sentAt: { $gte: cutoff },
                gmailThreadId: { $ne: null },
            })
                .toArray();
            const grouped = new Map();
            for (const t of threads) {
                if (!t.gmailThreadId || !t.sentAt)
                    continue;
                const cur = grouped.get(t.gmailThreadId);
                if (!cur || t.sentAt > cur.sent_at) {
                    grouped.set(t.gmailThreadId, {
                        sent_at: t.sentAt,
                        sent_message_id: t._id,
                        contact_id: t.contactId,
                    });
                }
            }
            if (grouped.size === 0)
                return { scanned, inserted };
            const tok = await getActiveAccessToken(userId);
            if (!tok)
                return { scanned, inserted };
            const ourEmail = (tok.email ?? '').toLowerCase();
            for (const [threadId, ctx] of grouped) {
                scanned++;
                try {
                    const thread = await getThread(tok.accessToken, threadId);
                    for (const m of thread.messages ?? []) {
                        const fromHeader = headerValue(m.payload?.headers, 'From') ?? '';
                        const fromEmail = extractEmail(fromHeader).toLowerCase();
                        if (!fromEmail || fromEmail === ourEmail)
                            continue;
                        const existing = await db
                            .collection('replies')
                            .findOne({ gmailMessageId: m.id });
                        if (existing)
                            continue;
                        const full = await getMessageFull(tok.accessToken, m.id);
                        const body = extractPlainText(full.payload);
                        const subject = headerValue(full.payload.headers, 'Subject');
                        const dateHeader = headerValue(full.payload.headers, 'Date');
                        const receivedAt = dateHeader ? new Date(dateHeader) : new Date();
                        const now = new Date();
                        await db.collection('replies').insertOne({
                            _id: newId(),
                            userId,
                            contactId: ctx.contact_id,
                            sentMessageId: ctx.sent_message_id,
                            gmailMessageId: m.id,
                            gmailThreadId: threadId,
                            fromEmail,
                            subject,
                            body,
                            snippet: full.snippet,
                            classification: null,
                            urgency: null,
                            keyPoints: null,
                            suggestedResponse: null,
                            recommendedAction: null,
                            status: 'received',
                            notes: null,
                            handled: false,
                            receivedAt,
                            createdAt: now,
                            updatedAt: now,
                        });
                        inserted++;
                    }
                }
                catch (err) {
                    errors.push({ user_id: userId, error: err instanceof Error ? err.message : 'thread_failed' });
                }
            }
        }
        catch (err) {
            errors.push({ user_id: userId, error: err instanceof Error ? err.message : 'user_failed' });
        }
        return { scanned, inserted };
    }
    const CONCURRENCY = 10;
    for (let i = 0; i < userIds.length; i += CONCURRENCY) {
        const slice = userIds.slice(i, i + CONCURRENCY);
        const results = await Promise.all(slice.map(processUser));
        for (const r of results) {
            totalScanned += r.scanned;
            totalInserted += r.inserted;
        }
    }
    return res.status(200).json({
        users: userIds.length,
        threads_scanned: totalScanned,
        replies_inserted: totalInserted,
        errors,
    });
}
function extractEmail(header) {
    const m = header.match(/<([^>]+)>/);
    if (m)
        return m[1].trim();
    return header.trim();
}
