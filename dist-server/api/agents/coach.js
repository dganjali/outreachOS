import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { MODEL, createMessageWithRetry, extractJson } from '../_lib/anthropic';
import { COACH_SYSTEM } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
const COACHABLE_FIELDS = new Set([
    'bio', 'proof_points', 'achievements', 'metrics', 'writing_tone', 'example_emails',
]);
const FIELD_LABEL = {
    bio: 'Bio (positioning paragraph)',
    proof_points: 'Proof points (credibility anchors)',
    achievements: 'Achievements',
    metrics: 'Metrics (concrete outcomes)',
    writing_tone: 'Preferred writing tone (1 short phrase)',
    example_emails: 'Example emails (style reference)',
};
export default async function handler(req, res) {
    if (req.method !== 'POST')
        return methodNotAllowed(res, ['POST']);
    const user = await requireUser(req, res);
    if (!user)
        return;
    const scope = forUser(user.id);
    const { field, current_value } = (req.body ?? {});
    if (!field || !COACHABLE_FIELDS.has(field)) {
        return res.status(400).json({ error: 'invalid_field' });
    }
    const f = field;
    if (!(await checkRateLimit(scope, res)))
        return;
    const profile = await scope.collection('profiles').findOne();
    if (!profile)
        return res.status(404).json({ error: 'profile_not_found' });
    const currentValue = (current_value ?? '').toString().slice(0, 4000);
    // Outcome stats for THIS field
    const sentRows = await scope.collection('sent_messages').find();
    let fieldSentCount = 0;
    const sentIdsForField = new Set();
    for (const row of sentRows) {
        if (!Array.isArray(row.profileRefs))
            continue;
        if (row.profileRefs.some((r) => r?.field === f)) {
            fieldSentCount += 1;
            sentIdsForField.add(row._id);
        }
    }
    let fieldReplyCount = 0;
    if (sentIdsForField.size > 0) {
        const replyRows = await scope.collection('replies').find();
        fieldReplyCount = replyRows.filter((r) => r.sentMessageId && sentIdsForField.has(r.sentMessageId) && r.classification !== 'oof' && r.classification !== 'unsubscribe').length;
    }
    const outcomes = {
        sent_count: fieldSentCount,
        reply_count: fieldReplyCount,
        reply_rate: fieldSentCount > 0 ? Math.round((fieldReplyCount / fieldSentCount) * 1000) / 10 : 0,
    };
    const run = await startRun(scope, {
        agentType: 'coach',
        input: { field: f, length: currentValue.length, ...outcomes },
    });
    try {
        const userPrompt = buildPrompt(f, currentValue, profile, outcomes);
        const message = await createMessageWithRetry({
            model: MODEL(),
            max_tokens: 1500,
            system: COACH_SYSTEM,
            messages: [{ role: 'user', content: userPrompt }],
        });
        const parsed = extractJson(message);
        if (!parsed.ok || !parsed.data) {
            await failRun(scope, run._id, 'parse_failed');
            return res.status(502).json({ error: 'parse_failed' });
        }
        const cleaned = {
            suggestions: (parsed.data.suggestions ?? [])
                .filter((s) => s && typeof s.rewrite === 'string' && s.rewrite.trim().length > 0)
                .slice(0, 3)
                .map((s) => ({
                title: (s.title ?? 'Suggestion').toString().slice(0, 60),
                rewrite: s.rewrite.toString().slice(0, 4000),
                why: (s.why ?? '').toString().slice(0, 300),
            })),
            gaps: (parsed.data.gaps ?? [])
                .filter((g) => typeof g === 'string' && g.trim().length > 0)
                .slice(0, 6)
                .map((g) => g.slice(0, 200)),
        };
        await completeRun(scope, run._id, {
            field: f,
            suggestion_count: cleaned.suggestions.length,
            gap_count: cleaned.gaps.length,
        });
        return res.status(200).json({ run_id: run._id, field: f, ...cleaned, outcomes });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown_error';
        await failRun(scope, run._id, msg);
        return res.status(500).json({ error: 'agent_failed', detail: msg });
    }
}
function buildPrompt(field, currentValue, profile, outcomes) {
    const ctxLines = [
        'PROFILE CONTEXT (other fields of the same user — use as ground truth, never invent beyond this):',
        profile.name ? `Name: ${profile.name}` : '',
        profile.role ? `Role: ${profile.role}` : '',
        profile.organization ? `Org: ${profile.organization}` : '',
        profile.linkedinUrl ? `LinkedIn: ${profile.linkedinUrl}` : '',
        profile.website ? `Website: ${profile.website}` : '',
        profile.portfolioLinks?.length ? `Portfolio: ${profile.portfolioLinks.join(', ')}` : '',
        field !== 'bio' && profile.bio ? `Bio: ${profile.bio}` : '',
        field !== 'proof_points' && profile.proofPoints ? `Proof points: ${profile.proofPoints}` : '',
        field !== 'achievements' && profile.achievements ? `Achievements: ${profile.achievements}` : '',
        field !== 'metrics' && profile.metrics ? `Metrics: ${profile.metrics}` : '',
        field !== 'writing_tone' && profile.writingTone ? `Tone: ${profile.writingTone}` : '',
    ].filter(Boolean);
    const outcomesBlock = outcomes.sent_count === 0
        ? 'OUTCOMES: this field has not shipped in any sent message yet.'
        : `OUTCOMES: this field has been cited in ${outcomes.sent_count} sent message${outcomes.sent_count === 1 ? '' : 's'}, producing ${outcomes.reply_count} reply${outcomes.reply_count === 1 ? '' : 'ies'} (${outcomes.reply_rate}% reply rate). ${outcomes.sent_count >= 5 && outcomes.reply_count === 0
            ? "It's underperforming — be willing to take a structurally different angle, not a polish pass."
            : outcomes.reply_count > 0
                ? 'Preserve what is working; sharpen rather than rebuild.'
                : ''}`.trim();
    return [
        `FIELD TO COACH: ${FIELD_LABEL[field]}`,
        '',
        'CURRENT VALUE:',
        currentValue.trim() || '(empty — propose a strong starting point grounded in PROFILE CONTEXT)',
        '',
        outcomesBlock,
        '',
        ctxLines.join('\n'),
        '',
        'Return JSON only.',
    ].join('\n');
}
