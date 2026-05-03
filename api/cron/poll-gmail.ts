import type { VercelRequest, VercelResponse } from '@vercel/node';
import { adminClient } from '../_lib/supabase';
import {
  getActiveAccessToken,
  getThread,
  getMessageFull,
  extractPlainText,
  headerValue,
} from '../_lib/gmail';

// Vercel Cron hits this with `Authorization: Bearer ${CRON_SECRET}`.
// Configure schedule in vercel.json.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (cronSecret) {
    if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'unauthorized' });
  }

  const db = adminClient();

  // Find users with active Gmail + at least one sent message in last 30 days.
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: users } = await db
    .from('user_integrations')
    .select('user_id')
    .eq('provider', 'gmail')
    .eq('status', 'active');

  const userIds = (users ?? []).map((u) => u.user_id as string);
  if (userIds.length === 0) return res.status(200).json({ checked: 0 });

  let inserted = 0;
  let scanned = 0;
  const errors: Array<{ user_id: string; error: string }> = [];

  for (const userId of userIds) {
    try {
      // Fetch active threads for this user
      const { data: threads } = await db
        .from('sent_messages')
        .select('gmail_thread_id, gmail_message_id, contact_id, sent_at, id')
        .eq('user_id', userId)
        .eq('status', 'sent')
        .gte('sent_at', cutoff)
        .not('gmail_thread_id', 'is', null);

      const grouped = new Map<string, { sent_at: string; sent_message_id: string; contact_id: string }>();
      for (const t of threads ?? []) {
        const tid = t.gmail_thread_id as string;
        const cur = grouped.get(tid);
        if (!cur || (t.sent_at as string) > cur.sent_at) {
          grouped.set(tid, {
            sent_at: t.sent_at as string,
            sent_message_id: t.id as string,
            contact_id: t.contact_id as string,
          });
        }
      }

      if (grouped.size === 0) continue;

      const tok = await getActiveAccessToken(userId);
      if (!tok) continue;
      const ourEmail = (tok.email ?? '').toLowerCase();

      for (const [threadId, ctx] of grouped) {
        scanned++;
        try {
          const thread = await getThread(tok.accessToken, threadId);
          for (const m of thread.messages ?? []) {
            const fromHeader = headerValue(m.payload?.headers, 'From') ?? '';
            const fromEmail = extractEmail(fromHeader).toLowerCase();
            if (!fromEmail || fromEmail === ourEmail) continue; // skip our own sends

            // Already recorded?
            const { data: existing } = await db
              .from('replies')
              .select('id')
              .eq('gmail_message_id', m.id)
              .maybeSingle();
            if (existing) continue;

            // Fetch body
            const full = await getMessageFull(tok.accessToken, m.id);
            const body = extractPlainText(full.payload);
            const subject = headerValue(full.payload.headers, 'Subject');
            const dateHeader = headerValue(full.payload.headers, 'Date');
            const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

            await db.from('replies').insert({
              user_id: userId,
              contact_id: ctx.contact_id,
              sent_message_id: ctx.sent_message_id,
              gmail_message_id: m.id,
              gmail_thread_id: threadId,
              from_email: fromEmail,
              subject,
              body,
              snippet: full.snippet,
              status: 'received',
              received_at: receivedAt,
              handled: false,
            });
            inserted++;
          }
        } catch (err) {
          errors.push({ user_id: userId, error: err instanceof Error ? err.message : 'thread_failed' });
        }
      }
    } catch (err) {
      errors.push({ user_id: userId, error: err instanceof Error ? err.message : 'user_failed' });
    }
  }

  return res.status(200).json({ users: userIds.length, threads_scanned: scanned, replies_inserted: inserted, errors });
}

function extractEmail(header: string): string {
  const m = header.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return header.trim();
}
