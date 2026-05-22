// Apollo.io client — optional. Active only when APOLLO_API_KEY is set.
// Docs: https://docs.apollo.io/reference
const BASE = 'https://api.apollo.io/api/v1';
export function apolloEnabled() {
    return !!process.env.APOLLO_API_KEY;
}
async function apolloPost(path, body) {
    const key = process.env.APOLLO_API_KEY;
    if (!key)
        throw new Error('apollo_not_configured');
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
            Accept: 'application/json',
            'X-Api-Key': key,
        },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let payload = null;
    try {
        payload = text ? JSON.parse(text) : null;
    }
    catch {
        /* fallthrough */
    }
    if (!res.ok) {
        const detail = payload?.message
            ?? payload?.error
            ?? text.slice(0, 300);
        throw new Error(`apollo_${res.status}: ${detail}`);
    }
    return payload;
}
export async function searchOrganizations(filters) {
    const body = {
        page: filters.page ?? 1,
        per_page: Math.min(filters.per_page ?? 25, 100),
    };
    if (filters.q_keywords)
        body.q_keywords = filters.q_keywords;
    if (filters.organization_locations?.length)
        body.organization_locations = filters.organization_locations;
    if (filters.organization_num_employees_ranges?.length)
        body.organization_num_employees_ranges = filters.organization_num_employees_ranges;
    if (filters.organization_industry_tag_ids?.length)
        body.organization_industry_tag_ids = filters.organization_industry_tag_ids;
    if (filters.q_organization_keyword_tags?.length)
        body.q_organization_keyword_tags = filters.q_organization_keyword_tags;
    if (filters.organization_latest_funding_stage_cd?.length)
        body.organization_latest_funding_stage_cd = filters.organization_latest_funding_stage_cd;
    const json = await apolloPost('/mixed_companies/search', body);
    // Apollo returns "organizations" plus optional "accounts" (saved accounts).
    return [...(json.organizations ?? []), ...(json.accounts ?? [])];
}
export async function searchPeople(filters) {
    const body = {
        page: filters.page ?? 1,
        per_page: Math.min(filters.per_page ?? 10, 100),
    };
    if (filters.person_titles?.length)
        body.person_titles = filters.person_titles;
    if (filters.person_seniorities?.length)
        body.person_seniorities = filters.person_seniorities;
    if (filters.q_organization_domains)
        body.q_organization_domains = filters.q_organization_domains;
    if (filters.organization_ids?.length)
        body.organization_ids = filters.organization_ids;
    if (filters.q_keywords)
        body.q_keywords = filters.q_keywords;
    if (filters.contact_email_status?.length)
        body.contact_email_status = filters.contact_email_status;
    const json = await apolloPost('/mixed_people/search', body);
    return [...(json.people ?? []), ...(json.contacts ?? [])];
}
export async function matchPerson(input) {
    const body = {};
    if (input.email)
        body.email = input.email;
    if (input.linkedin_url)
        body.linkedin_url = input.linkedin_url;
    if (input.first_name)
        body.first_name = input.first_name;
    if (input.last_name)
        body.last_name = input.last_name;
    if (input.organization_name)
        body.organization_name = input.organization_name;
    if (input.domain)
        body.domain = input.domain;
    if (input.reveal_personal_emails)
        body.reveal_personal_emails = true;
    const json = await apolloPost('/people/match', body);
    return json.person ?? null;
}
// Map Apollo's email_status values to our internal enum.
export function normalizeEmailStatus(s) {
    if (!s)
        return 'none';
    const v = s.toLowerCase();
    if (v.includes('verified'))
        return 'verified';
    if (v.includes('likely'))
        return 'likely';
    if (v.includes('guess') || v.includes('inferred'))
        return 'guessed';
    return 'none';
}
export function fullName(p) {
    if (p.name)
        return p.name;
    return [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
}
