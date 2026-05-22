// Agent run telemetry + per-user rate limiting. Mongo edition.
import { newId } from './db';
const RATE_PER_MINUTE = 5;
const RATE_PER_DAY = 50;
export async function checkRateLimit(scope, res) {
    const now = Date.now();
    const minuteAgo = new Date(now - 60_000);
    const dayAgo = new Date(now - 86_400_000);
    const runs = scope.collection('agent_runs');
    const [perMinute, perDay] = await Promise.all([
        runs.countDocuments({ startedAt: { $gte: minuteAgo } }),
        runs.countDocuments({ startedAt: { $gte: dayAgo } }),
    ]);
    if (perMinute >= RATE_PER_MINUTE) {
        res.status(429).json({ error: 'rate_limit_exceeded', detail: 'Too many requests — wait a minute and retry.' });
        return false;
    }
    if (perDay >= RATE_PER_DAY) {
        res.status(429).json({ error: 'rate_limit_exceeded', detail: 'Daily agent run limit reached.' });
        return false;
    }
    return true;
}
export async function startRun(scope, args) {
    const now = new Date();
    const doc = await scope.collection('agent_runs').insertOne({
        _id: newId(),
        agentType: args.agentType,
        missionId: args.missionId ?? null,
        targetId: args.targetId ?? null,
        contactId: args.contactId ?? null,
        input: args.input ?? null,
        output: null,
        error: null,
        status: 'running',
        startedAt: now,
        completedAt: null,
    });
    return doc;
}
export async function completeRun(scope, id, output) {
    await scope.collection('agent_runs').updateById(id, {
        status: 'completed',
        output,
        completedAt: new Date(),
    });
}
export async function failRun(scope, id, error) {
    await scope.collection('agent_runs').updateById(id, {
        status: 'failed',
        error,
        completedAt: new Date(),
    });
}
