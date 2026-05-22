// Sequence agent — writes the initial + follow-up emails.
//
// New (vs Supabase version):
//   - Uses Atlas Vector Search to retrieve past sequences that got replies as
//     exemplars for new generations. Falls back gracefully if vector index
//     isn't ready.
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { adminDb, forUser, newId } from '../_lib/db';
import { createMessageWithRetry, MODEL, extractJson } from '../_lib/anthropic';
import { sequenceSystem } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { embedOne } from '../_lib/embeddings';
const PROFILE_REF_FIELDS = new Set([
    'bio', 'proof_points', 'achievements', 'metrics', 'writing_tone', 'example_emails',
]);
function cleanProfileRefs(raw) {
    if (!raw || typeof raw !== 'object')
        return {};
    const out = {};
    for (const [touchKey, refs] of Object.entries(raw)) {
        if (!Array.isArray(refs))
            continue;
        const cleaned = [];
        for (const r of refs) {
            if (!r || typeof r !== 'object')
                continue;
            const obj = r;
            const field = obj.field;
            const snippet = obj.snippet;
            if (typeof field === 'string' && PROFILE_REF_FIELDS.has(field)) {
                cleaned.push({
                    field: field,
                    snippet: typeof snippet === 'string' ? snippet.slice(0, 240) : '',
                });
            }
        }
        if (cleaned.length > 0)
            out[touchKey] = cleaned;
    }
    return out;
}
export default async function handler(req, res) {
    if (req.method !== 'POST')
        return methodNotAllowed(res, ['POST']);
    const user = await requireUser(req, res);
    if (!user)
        return;
    const scope = forUser(user.id);
    if (!(await checkRateLimit(scope, res)))
        return;
    const { contact_id } = (req.body ?? {});
    if (!contact_id)
        return res.status(400).json({ error: 'missing_contact_id' });
    const contact = await scope.collection('contacts').findById(contact_id);
    if (!contact)
        return res.status(404).json({ error: 'contact_not_found' });
    const target = await scope.collection('targets').findById(contact.targetId);
    if (!target)
        return res.status(404).json({ error: 'target_not_found' });
    const mission = await scope.collection('missions').findById(target.missionId);
    if (!mission)
        return res.status(404).json({ error: 'mission_not_found' });
    const profile = await scope.collection('profiles').findOne();
    // Latest evidence pack for this target
    const packs = await scope
        .collection('evidence_packs')
        .find({ targetId: target._id });
    packs.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    const latestPack = packs[0] ?? null;
    const bullets = latestPack?.bullets ?? [];
    if (bullets.length === 0) {
        return res.status(409).json({ error: 'no_evidence_pack', message: 'Generate an evidence pack first.' });
    }
    const run = await startRun(scope, {
        agentType: 'sequence',
        missionId: mission._id,
        targetId: target._id,
        contactId: contact_id,
    });
    const mode = mission.mode ?? 'sales';
    const evidenceText = bullets
        .map((b, i) => `[${i}] ${b.fact} — ${b.sourceTitle ?? ''} (${b.recency ?? ''})`)
        .join('\n');
    const linkedinSummary = profile?.linkedinData
        ? summarizeLinkedinData(profile.linkedinData)
        : '';
    const senderBlock = profile
        ? [
            `Name: ${profile.name ?? 'Unknown'}`,
            profile.role ? `Role: ${profile.role}` : '',
            profile.organization ? `Org: ${profile.organization}` : '',
            profile.bio ? `Bio: ${profile.bio}` : '',
            profile.proofPoints ? `Proof points: ${profile.proofPoints}` : '',
            profile.achievements ? `Achievements: ${profile.achievements}` : '',
            profile.metrics ? `Metrics: ${profile.metrics}` : '',
            profile.writingTone ? `Preferred tone: ${profile.writingTone}` : '',
            profile.linkedinUrl ? `LinkedIn: ${profile.linkedinUrl}` : '',
            linkedinSummary ? `LinkedIn signal:\n${linkedinSummary}` : '',
        ]
            .filter(Boolean)
            .join('\n')
        : 'No sender profile provided.';
    // Retrieve top-3 past sequences (from THIS user) that got replies, as exemplars.
    const exemplars = await fetchReplyExemplars(scope.uid, mission.goal);
    const userPrompt = [
        `RECIPIENT`,
        `Name: ${contact.name}`,
        `Role: ${contact.role}`,
        `Company: ${target.companyName}`,
        '',
        `MISSION`,
        `Goal / what's being offered: ${mission.goal}`,
        `Audience description: ${mission.targetDescription}`,
        target.whyNow ? `Why now (target): ${target.whyNow}` : '',
        '',
        `EVIDENCE PACK (use indices in anchored_bullets)`,
        evidenceText,
        '',
        `SENDER PROFILE`,
        senderBlock,
        profile?.exampleEmails ? `\nSENDER EXAMPLE EMAILS (style reference, do not copy)\n${profile.exampleEmails}` : '',
        exemplars
            ? `\nPAST EMAILS THAT GOT REPLIES (from your own outbox, retrieved by semantic similarity — emulate the tone/structure, NOT the specifics):\n${exemplars}`
            : '',
        '',
        'Output JSON only.',
    ]
        .filter(Boolean)
        .join('\n');
    try {
        const message = await createMessageWithRetry({
            model: MODEL(),
            max_tokens: 2048,
            system: sequenceSystem(mode),
            messages: [{ role: 'user', content: userPrompt }],
        });
        const parsed = extractJson(message);
        if (!parsed.ok || !parsed.data?.initial) {
            await failRun(scope, run._id, 'parse_failed');
            return res.status(502).json({ error: 'parse_failed', raw: parsed.raw.slice(0, 500) });
        }
        const seq = parsed.data;
        const profileRefs = cleanProfileRefs(seq.profile_refs);
        const versions = await scope.collection('profile_versions').find();
        versions.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
        const latestVersion = versions[0] ?? null;
        let embedding;
        try {
            embedding = await embedOne(`${seq.initial.subject}\n\n${seq.initial.body}`, 'document');
        }
        catch (err) {
            console.warn('embed_sequence_failed', err);
        }
        const followups = (seq.followups ?? []).map((f) => ({
            waitDays: f.wait_days,
            subject: f.subject,
            body: f.body,
        }));
        const row = await scope.collection('email_sequences').insertOne({
            _id: newId(),
            contactId: contact_id,
            targetId: target._id,
            missionId: mission._id,
            evidencePackId: latestPack?._id ?? null,
            primaryAngle: seq.primary_angle,
            anchoredBullets: seq.anchored_bullets ?? [],
            subject: seq.initial.subject,
            body: seq.initial.body,
            followups,
            status: 'draft',
            scheduledSendAt: null,
            sentAt: null,
            profileVersionId: latestVersion?._id ?? null,
            // profileRefs is not a schema field but kept on the doc so the send agent
            // can attribute back to coached fields. Stored as an extra prop.
            ...{ profileRefs },
            ...(embedding ? { embedding } : {}),
        });
        await completeRun(scope, run._id, { sequence_id: row._id });
        return res.status(200).json({ run_id: run._id, sequence: row });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown_error';
        await failRun(scope, run._id, msg);
        return res.status(500).json({ error: 'agent_failed', detail: msg });
    }
}
async function fetchReplyExemplars(uid, missionGoal) {
    try {
        const queryEmbedding = await embedOne(missionGoal, 'query');
        const db = await adminDb();
        const cursor = db.collection('email_sequences').aggregate([
            {
                $vectorSearch: {
                    index: 'sequence_vector_idx',
                    path: 'embedding',
                    queryVector: queryEmbedding,
                    numCandidates: 50,
                    limit: 3,
                    filter: { userId: uid, status: 'replied' },
                },
            },
            { $project: { subject: 1, body: 1, primaryAngle: 1, score: { $meta: 'vectorSearchScore' } } },
        ]);
        const docs = await cursor.toArray();
        if (docs.length === 0)
            return null;
        return docs
            .map((d, i) => `--- Exemplar ${i + 1} (angle: ${d.primaryAngle ?? '?'}) ---\nSubject: ${d.subject}\n\n${d.body}`)
            .join('\n\n');
    }
    catch (err) {
        // Vector index not provisioned yet, or query failed — that's fine, exemplars are optional.
        return null;
    }
}
function summarizeLinkedinData(data) {
    const out = [];
    if (data.headline)
        out.push(`Headline: ${data.headline}`);
    if (data.title)
        out.push(`Title: ${data.title}`);
    const org = data.organization;
    if (org?.name)
        out.push(`Org: ${org.name}${org.industry ? ` (${org.industry})` : ''}`);
    const history = data.employment_history;
    if (history?.length) {
        const recent = history
            .slice(0, 4)
            .map((h) => `- ${h.title ?? '?'} @ ${h.organization ?? '?'}${h.current ? ' (current)' : ''}`);
        out.push(`Recent roles:\n${recent.join('\n')}`);
    }
    return out.join('\n');
}
