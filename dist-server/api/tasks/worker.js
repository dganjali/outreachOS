// Cloud Tasks worker — single endpoint that all queued tasks call back into.
//
// Auth: Cloud Tasks sends an OIDC token signed by CLOUD_TASKS_SERVICE_ACCOUNT.
// We don't validate the OIDC token here (a Cloud Run "require auth" setting
// would be cleaner) — set this route's service to "require authentication"
// in Cloud Run and grant the task service account `roles/run.invoker`.
import { forUser } from '../_lib/db';
import { getActiveAccessToken, sendNow } from '../_lib/gmail';
export default async function handler(req, res) {
    const body = req.body;
    if (!body?.kind)
        return res.status(400).json({ error: 'missing_kind' });
    try {
        switch (body.kind) {
            case 'send-sequence-touch':
                await sendSequenceTouch(body.payload);
                return res.status(200).json({ ok: true });
            // Other kinds (embed-evidence-pack, embed-email-sequence,
            // poll-gmail-for-user) are stubs for future expansion.
            default:
                return res.status(400).json({ error: 'unknown_kind', kind: body.kind });
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'task_failed';
        console.error('task_failed', body.kind, msg);
        // 5xx makes Cloud Tasks retry with exponential backoff.
        return res.status(500).json({ error: msg });
    }
}
async function sendSequenceTouch(payload) {
    const uid = String(payload.userId ?? '');
    const sentMessageId = String(payload.sentMessageId ?? '');
    if (!uid || !sentMessageId)
        throw new Error('missing_ids');
    const scope = forUser(uid);
    const sent = await scope
        .collection('sent_messages')
        .findById(sentMessageId);
    if (!sent || sent.status !== 'queued')
        return; // already handled or canceled
    const seq = await scope
        .collection('email_sequences')
        .findById(sent.sequenceId);
    if (!seq)
        throw new Error('sequence_missing');
    const tok = await getActiveAccessToken(uid);
    if (!tok) {
        await scope.collection('sent_messages').updateById(sentMessageId, {
            status: 'failed',
            failedReason: 'gmail_not_connected',
        });
        return;
    }
    const result = await sendNow({
        accessToken: tok.accessToken,
        fromEmail: tok.email ?? '',
        toEmail: sent.toEmail,
        subject: sent.subject,
        body: sent.body,
        threadId: sent.gmailThreadId ?? undefined,
    });
    await scope.collection('sent_messages').updateById(sentMessageId, {
        status: 'sent',
        sentAt: new Date(),
        gmailMessageId: result.messageId,
        gmailThreadId: result.threadId,
    });
    if (sent.touchIndex === 0) {
        await scope.collection('email_sequences').updateById(sent.sequenceId, {
            status: 'sent',
            sentAt: new Date(),
        });
        await scope.collection('contacts').updateById(sent.contactId, { status: 'contacted' });
    }
}
