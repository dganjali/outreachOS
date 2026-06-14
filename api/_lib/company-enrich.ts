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

// ---------------------------------------------------------------------------
// Company-size enrichment (CONTACT_ENGINE.md §6). A headcount lets the contact
// engine shift the seniority band by size tier. Best-effort: parse it out of a
// LinkedIn company-page snippet; return null (→ the "unknown" band) on a miss
// rather than guessing.
// ---------------------------------------------------------------------------

/**
 * Pull an employee count out of free text like "10,001+ employees" or
 * "1,001-5,000 employees" (the LinkedIn company-size format). For a range we
 * take the upper bound; for "N+" we take N. Returns null when nothing matches.
 */
export function parseEmployeeCount(text: string): number | null {
  const t = (text ?? '').replace(/ /g, ' ');
  const toNum = (s: string) => Number(s.replace(/,/g, ''));

  // Range: "1,001-5,000 employees" → upper bound.
  const range = t.match(/([\d,]+)\s*[-–]\s*([\d,]+)\s*employees/i);
  if (range) {
    const hi = toNum(range[2]);
    if (Number.isFinite(hi) && hi > 0) return hi;
  }
  // "10,001+ employees" → the floor number.
  const plus = t.match(/([\d,]+)\+\s*employees/i);
  if (plus) {
    const n = toNum(plus[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Plain "250 employees".
  const plain = t.match(/([\d,]+)\s*employees/i);
  if (plain) {
    const n = toNum(plain[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Resolve a company's employee count via the LinkedIn company page snippet. */
export async function enrichCompanySize(name: string, domain?: string | null): Promise<number | null> {
  if (!serperEnabled() || !name.trim()) return null;
  const q = `site:linkedin.com/company "${name.trim()}"${domain ? ` ${domain}` : ''}`;
  try {
    const results = await search(q, 3);
    for (const r of results) {
      const n = parseEmployeeCount(`${r.title} ${r.snippet}`);
      if (n) return n;
    }
  } catch (err) {
    console.warn('enrich_company_size_failed', name, err);
  }
  return null;
}
