// Cloud Tasks — replaces "background job queue" and "auto-send scheduler"
// that were on the deferred list.
//
// Usage:
//   await enqueue('send-sequence-touch', { sentMessageId }, { scheduleTime })
// Cloud Tasks POSTs to ${CLOUD_TASKS_TARGET_URL} with the body. The worker
// route lives at /api/tasks/worker and dispatches by `kind`.
import { CloudTasksClient } from '@google-cloud/tasks';
import { env } from './env';
let _client = null;
function client() {
    if (_client)
        return _client;
    _client = new CloudTasksClient();
    return _client;
}
export async function enqueue(kind, payload, opts = {}) {
    const parent = client().queuePath(env.GCP_PROJECT_ID(), env.GCP_REGION(), env.CLOUD_TASKS_QUEUE());
    const body = { kind, payload };
    const task = {
        httpRequest: {
            httpMethod: 'POST',
            url: env.CLOUD_TASKS_TARGET_URL(),
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify(body)).toString('base64'),
            oidcToken: {
                serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT(),
            },
        },
    };
    if (opts.scheduleTime) {
        task.scheduleTime = {
            seconds: Math.floor(opts.scheduleTime.getTime() / 1000),
        };
    }
    if (opts.dedupeKey) {
        // Cloud Tasks dedupes within ~1 hour windows on identical names.
        task.name = `${parent}/tasks/${opts.dedupeKey.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    }
    const [created] = await client().createTask({ parent, task: task });
    return created.name ?? '';
}
