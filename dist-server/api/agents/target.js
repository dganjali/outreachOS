// Targeting agent — finds organizations to outreach.
// Mongo + Express edition.
import { requireUser, methodNotAllowed } from '../_lib/auth';
import { forUser, newId } from '../_lib/db';
import { createMessageWithRetry, MODEL, WEB_SEARCH_TOOL, extractJson } from '../_lib/anthropic';
import { TARGETING_SYSTEM, TARGETING_FILTER_SYSTEM, TARGETING_RANK_SYSTEM, } from '../_lib/prompts';
import { startRun, completeRun, failRun, checkRateLimit } from '../_lib/runs';
import { apolloEnabled, searchOrganizations, } from '../_lib/apollo';
export default async function handler(req, res) {
    if (req.method !== 'POST')
        return methodNotAllowed(res, ['POST']);
    const user = await requireUser(req, res);
    if (!user)
        return;
    const scope = forUser(user.id);
    if (!(await checkRateLimit(scope, res)))
        return;
    const { mission_id, count } = (req.body ?? {});
    if (!mission_id)
        return res.status(400).json({ error: 'missing_mission_id' });
    const mission = await scope.collection('missions').findById(mission_id);
    if (!mission)
        return res.status(404).json({ error: 'mission_not_found' });
    const profile = await scope.collection('profiles').findOne();
    const desired = Math.min(Math.max(count ?? 10, 1), 25);
    const useApollo = apolloEnabled();
    const run = await startRun(scope, {
        agentType: 'targeting',
        missionId: mission_id,
        input: { count: desired, source: useApollo ? 'apollo' : 'web_search' },
    });
    const mode = mission.mode ?? 'sales';
    try {
        let rows;
        if (useApollo) {
            rows = await runApolloHybrid({ mission, mode, desired, profile, mission_id });
        }
        else {
            rows = await runWebSearchOnly({ mission, mode, desired, profile, mission_id });
        }
        if (rows.length === 0) {
            await failRun(scope, run._id, 'no_targets_found');
            return res.status(502).json({ error: 'no_targets_found' });
        }
        const inserted = await scope
            .collection('targets')
            .insertMany(rows.map((r) => ({ ...r, _id: newId() })));
        await completeRun(scope, run._id, {
            count: inserted.length,
            source: useApollo ? 'apollo' : 'web_search',
        });
        return res.status(200).json({
            run_id: run._id,
            targets: inserted,
            source: useApollo ? 'apollo' : 'web_search',
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown_error';
        await failRun(scope, run._id, msg);
        return res.status(500).json({ error: 'agent_failed', detail: msg });
    }
}
async function runWebSearchOnly(args) {
    const { mission, mode, desired, profile, mission_id } = args;
    const userPrompt = [
        `Mission: ${mission.name}`,
        `Mode: ${mode}`,
        `What I'm sending / offer: ${mission.goal}`,
        `Target description (the why): ${mission.targetDescription}`,
        profile?.name
            ? `Sender: ${profile.name}${profile.role ? `, ${profile.role}` : ''}${profile.organization ? ` at ${profile.organization}` : ''}`
            : '',
        profile?.proofPoints ? `Sender credibility: ${profile.proofPoints}` : '',
        '',
        `Find ${desired} target organizations with strong recent "why now" signals. Use web_search.`,
        'Return JSON only, no commentary.',
    ]
        .filter(Boolean)
        .join('\n');
    const message = await createMessageWithRetry({
        model: MODEL(),
        max_tokens: 4096,
        system: TARGETING_SYSTEM,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: 'user', content: userPrompt }],
    });
    const parsed = extractJson(message);
    if (!parsed.ok || !parsed.data?.targets)
        throw new Error('parse_failed');
    return parsed.data.targets.slice(0, 25).map((t) => ({
        missionId: mission_id,
        companyName: t.company_name,
        domain: t.domain,
        score: clamp(t.score, 0, 100),
        whyNow: t.why_now,
        fitReason: t.fit_reason,
        signalType: t.signal_type,
        status: 'suggested',
        source: 'web_search',
        apolloOrganizationId: null,
        industry: null,
        employeeCount: null,
        headquartersLocation: null,
    }));
}
async function runApolloHybrid(args) {
    const { mission, mode, desired, profile, mission_id } = args;
    const filterPrompt = [
        `Mission name: ${mission.name}`,
        `Mode: ${mode}`,
        `Offer: ${mission.goal}`,
        `Audience: ${mission.targetDescription}`,
        profile?.organization ? `Sender org (don't target): ${profile.organization}` : '',
        '',
        'Output Apollo filters as JSON only.',
    ]
        .filter(Boolean)
        .join('\n');
    const filterMsg = await createMessageWithRetry({
        model: MODEL(),
        max_tokens: 512,
        system: TARGETING_FILTER_SYSTEM,
        messages: [{ role: 'user', content: filterPrompt }],
    });
    const filterParsed = extractJson(filterMsg);
    const filters = filterParsed.ok && filterParsed.data ? filterParsed.data : {};
    const perPage = Math.min(Math.max(desired * 3, 20), 50);
    let candidates;
    try {
        candidates = await searchOrganizations({ ...filters, per_page: perPage });
    }
    catch (err) {
        console.error('apollo_search_failed', err);
        return runWebSearchOnly(args);
    }
    if (candidates.length === 0)
        return runWebSearchOnly(args);
    const sender = profile?.organization?.trim().toLowerCase();
    const trimmed = candidates
        .filter((o) => o.name && (!sender || o.name.toLowerCase() !== sender))
        .slice(0, perPage);
    const candidateList = trimmed.map((o, i) => ({
        idx: i,
        company_name: o.name,
        domain: o.primary_domain ?? domainFromUrl(o.website_url),
        industry: o.industry,
        employees: o.estimated_num_employees,
        location: [o.city, o.state, o.country].filter(Boolean).join(', '),
        funding_stage: o.latest_funding_stage,
        funding_date: o.latest_funding_round_date,
        short_description: o.short_description,
        keywords: o.keywords?.slice(0, 8),
        technologies: o.technology_names?.slice(0, 8),
    }));
    const rankPrompt = [
        `Mission: ${mission.name}`,
        `Mode: ${mode}`,
        `Offer: ${mission.goal}`,
        `Audience: ${mission.targetDescription}`,
        profile?.proofPoints ? `Sender credibility: ${profile.proofPoints}` : '',
        '',
        `Apollo candidates (${trimmed.length}):`,
        JSON.stringify(candidateList, null, 2),
        '',
        `Pick the top ${desired} for this mission. Use web_search to confirm or surface a recent "why now" signal for each. Return JSON only.`,
    ]
        .filter(Boolean)
        .join('\n');
    const rankMsg = await createMessageWithRetry({
        model: MODEL(),
        max_tokens: 4096,
        system: TARGETING_RANK_SYSTEM,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: 'user', content: rankPrompt }],
    });
    const rankParsed = extractJson(rankMsg);
    if (!rankParsed.ok || !rankParsed.data?.targets) {
        return trimmed.slice(0, desired).map((o) => ({
            missionId: mission_id,
            companyName: o.name,
            domain: o.primary_domain ?? domainFromUrl(o.website_url) ?? null,
            score: null,
            whyNow: null,
            fitReason: o.short_description ?? null,
            signalType: null,
            status: 'suggested',
            source: 'apollo',
            apolloOrganizationId: o.id ?? null,
            industry: o.industry ?? null,
            employeeCount: o.estimated_num_employees ?? null,
            headquartersLocation: [o.city, o.state, o.country].filter(Boolean).join(', ') || null,
        }));
    }
    const byName = new Map(trimmed.map((o) => [o.name?.toLowerCase() ?? '', o]));
    return rankParsed.data.targets.slice(0, desired).map((t) => {
        const apollo = byName.get(t.company_name.toLowerCase());
        return {
            missionId: mission_id,
            companyName: t.company_name,
            domain: t.domain ?? apollo?.primary_domain ?? domainFromUrl(apollo?.website_url) ?? null,
            score: clamp(t.score, 0, 100),
            whyNow: t.why_now,
            fitReason: t.fit_reason,
            signalType: t.signal_type,
            status: 'suggested',
            source: 'apollo',
            apolloOrganizationId: apollo?.id ?? null,
            industry: apollo?.industry ?? null,
            employeeCount: apollo?.estimated_num_employees ?? null,
            headquartersLocation: apollo
                ? [apollo.city, apollo.state, apollo.country].filter(Boolean).join(', ') || null
                : null,
        };
    });
}
function clamp(n, lo, hi) {
    if (typeof n !== 'number' || Number.isNaN(n))
        return lo;
    return Math.max(lo, Math.min(hi, n));
}
function domainFromUrl(url) {
    if (!url)
        return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        return u.hostname.replace(/^www\./, '');
    }
    catch {
        return null;
    }
}
