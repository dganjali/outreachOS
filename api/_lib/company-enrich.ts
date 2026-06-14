// Resolve missing company domains and scrape public emails. Prefers Serper (a
// cheap, deterministic Google SERP lookup) and falls back to the LLM web_search
// path when Serper is off or can't find a non-aggregator domain.

import { createMessageWithRetry, MODEL, WEB_SEARCH_TOOL, extractJson } from './llm';
import { normalizeDomain } from './sender-context';
import { serperEnabled, search, type SerperOrganicResult } from './serper';

interface DomainLookupRow {
  company_name: string;
  domain: string;
}

// Domains that are never a company's own website — search results love to rank
// these for a brand query, so we skip them when picking a domain off Serper.
const AGGREGATOR_DOMAINS = [
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com', 'crunchbase.com', 'wikipedia.org', 'github.com',
  'medium.com', 'bloomberg.com', 'glassdoor.com', 'indeed.com', 'pitchbook.com',
  'reddit.com', 'yelp.com', 'apple.com', 'google.com',
];

function isAggregator(domain: string): boolean {
  return AGGREGATOR_DOMAINS.some((a) => domain === a || domain.endsWith(`.${a}`));
}

/** Pick the first organic result that normalizes to a non-aggregator domain. */
export function pickDomainFromResults(results: SerperOrganicResult[]): string | null {
  for (const r of results) {
    const d = normalizeDomain(r.link);
    if (d && !isAggregator(d)) return d;
  }
  return null;
}

/** Resolve one company's domain via a single Serper query. null on miss/error. */
async function resolveDomainViaSerper(name: string, hint?: string): Promise<string | null> {
  const q = [`"${name}"`, hint ?? '', 'official website'].filter(Boolean).join(' ');
  try {
    return pickDomainFromResults(await search(q, 5));
  } catch (err) {
    console.warn('serper_domain_lookup_failed', name, err);
    return null;
  }
}

/** Batch-resolve official website domains for companies missing one. */
export async function resolveCompanyDomains(
  companies: Array<{ name: string; hint?: string }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (companies.length === 0) return out;

  // Serper-first: one cheap deterministic query per company. Whatever Serper
  // can't resolve falls through to the LLM web_search batch below.
  let pending = companies;
  if (serperEnabled()) {
    const unresolved: Array<{ name: string; hint?: string }> = [];
    for (const c of companies.slice(0, 12)) {
      const d = await resolveDomainViaSerper(c.name, c.hint);
      if (d) out.set(c.name.trim(), d);
      else unresolved.push(c);
    }
    pending = unresolved;
  }
  if (pending.length === 0) return out;

  const list = pending.slice(0, 12).map((c, i) => ({
    idx: i,
    company_name: c.name,
    context: c.hint ?? '',
  }));

  const prompt = [
    'For each company below, find the official primary website domain via web_search.',
    'Return ONLY companies you can verify exist. domain must be bare hostname (e.g. sierra.ai), no https://.',
    'If you cannot verify a company or its website, omit it.',
    '',
    JSON.stringify(list, null, 2),
    '',
    'Output JSON: { "companies": [ { "company_name": "...", "domain": "..." } ] }',
  ].join('\n');

  try {
    const message = await createMessageWithRetry({
      model: MODEL(),
      max_tokens: 1024,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = extractJson<{ companies: DomainLookupRow[] }>(message);
    if (!parsed.ok || !parsed.data?.companies) return out;

    for (const row of parsed.data.companies) {
      const d = normalizeDomain(row.domain);
      if (d && row.company_name) out.set(row.company_name.trim(), d);
    }
  } catch (err) {
    console.warn('resolve_company_domains_failed', err);
  }

  return out;
}

export async function resolveCompanyDomain(
  companyName: string,
  hint?: string
): Promise<string | null> {
  const map = await resolveCompanyDomains([{ name: companyName, hint }]);
  return map.get(companyName.trim()) ?? [...map.values()][0] ?? null;
}
