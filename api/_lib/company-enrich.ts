// Resolve missing company domains and scrape public emails. Prefers Serper (a
// cheap, deterministic Google SERP lookup) and falls back to the LLM web_search
// path when Serper is off or can't find a non-aggregator domain.

import { createMessageWithRetry, MODEL, WEB_SEARCH_TOOL, extractJson } from './llm';
import { normalizeDomain } from './sender-context';
import { serperEnabled, search, type SerperOrganicResult } from './serper';
import { isDomainLive } from './web-scrape';

interface DomainLookupRow {
  company_name: string;
  domain: string;
}

// Domains that are never a company's own website - search results love to rank
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

/** Resolve one company's domain via a single Serper query. null on miss/error.
 *  We pull the top 10 (not 5) organic results: a brand query often ranks several
 *  aggregators (LinkedIn/Crunchbase/Wikipedia) above the company's own site, so
 *  the official domain can sit at position 6-10. The extra results cost nothing
 *  and keep us from dropping the real site behind aggregator noise. */
async function resolveDomainViaSerper(name: string, hint?: string): Promise<string | null> {
  const q = [`"${name}"`, hint ?? '', 'official website'].filter(Boolean).join(' ');
  try {
    return pickDomainFromResults(await search(q, 10));
  } catch (err) {
    console.warn('serper_domain_lookup_failed', name, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Name-based domain guess (fast path / fallback).
//
// When Serper is off, returns nothing, or returns only aggregators, a company
// with a null domain gets dropped (resolvePoolWithBudget returns [] on no
// domain). For most companies the official site is just <name>.com (or .ai/.io
// for startups), so we derive a few candidate hostnames straight from the name
// and accept the FIRST that actually serves a live page. This is conservative:
// we never accept a guess blindly - it must respond (2xx/3xx via isDomainLive).
// ---------------------------------------------------------------------------

// Corporate suffixes that aren't part of the brand's hostname (e.g. "Cohere
// Labs" → cohere.com, "Acme Inc" → acme.com).
const NAME_SUFFIXES = ['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'labs', 'ai'];

/** Candidate hostnames for a company name, best-guess first. "Cohere" →
 *  [cohere.com, cohere.ai, cohere.io]; "Sierra Studio" → sierrastudio.* plus a
 *  first-word-only sierra.* fallback. Lowercased, punctuation/space stripped. */
export function guessDomainCandidates(name: string): string[] {
  const cleaned = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ') // drop punctuation
    .trim();
  if (!cleaned) return [];

  // Drop trailing corporate suffixes ("cohere labs" → "cohere").
  let words = cleaned.split(/\s+/).filter(Boolean);
  while (words.length > 1 && NAME_SUFFIXES.includes(words[words.length - 1])) {
    words = words.slice(0, -1);
  }

  // Stems we'll try, most-specific first: the whole name joined, then just the
  // first word (covers "Sierra" for "Sierra Studio").
  const joined = words.join('');
  const stems = [joined];
  if (words.length > 1 && words[0] && words[0] !== joined) stems.push(words[0]);

  const tlds = ['com', 'ai', 'io'];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const stem of stems) {
    if (stem.length < 2) continue; // too short to be a real brand host
    for (const tld of tlds) {
      const host = `${stem}.${tld}`;
      if (!seen.has(host)) {
        seen.add(host);
        out.push(host);
      }
    }
  }
  return out;
}

/** Derive candidate hostnames from the name and return the first that serves a
 *  live page, else null. Probes candidates in order (most-specific first) so we
 *  stop at the first hit and don't fire a needless probe per company. `verify` is
 *  injectable so the heuristic is unit-testable without a real network probe. */
export async function guessDomainByName(
  name: string,
  verify: (host: string) => Promise<boolean> = isDomainLive
): Promise<string | null> {
  for (const host of guessDomainCandidates(name)) {
    if (await verify(host)) return host;
  }
  return null;
}

/** Batch-resolve official website domains for companies missing one. */
export async function resolveCompanyDomains(
  companies: Array<{ name: string; hint?: string }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (companies.length === 0) return out;

  // Serper-first: one cheap deterministic query per company. Whatever Serper
  // can't resolve falls through to the name-guess + LLM web_search below.
  let pending = companies;
  if (serperEnabled()) {
    // Run the per-company Serper lookups CONCURRENTLY (≤12) instead of serially -
    // each was an independent network round-trip, so this collapses ~12× latency
    // into one. allSettled so one query's failure never sinks the batch; the
    // resolveDomainViaSerper catch already maps errors to null anyway.
    const batch = companies.slice(0, 12);
    const settled = await Promise.allSettled(batch.map((c) => resolveDomainViaSerper(c.name, c.hint)));
    const unresolved: Array<{ name: string; hint?: string }> = [];
    settled.forEach((s, i) => {
      const d = s.status === 'fulfilled' ? s.value : null;
      if (d) out.set(batch[i].name.trim(), d);
      else unresolved.push(batch[i]);
    });
    pending = unresolved;
  }
  if (pending.length === 0) return out;

  // Name-guess fast path BEFORE the expensive LLM web_search. For most companies
  // the official site is just <name>.com/.ai/.io, and Serper either missed it or
  // returned only aggregators. We probe a few derived hostnames and accept the
  // first that actually responds (never a blind guess). Whatever this can't
  // verify still falls through to the LLM batch below.
  {
    const guessed = await Promise.allSettled(pending.map((c) => guessDomainByName(c.name)));
    const stillPending: Array<{ name: string; hint?: string }> = [];
    guessed.forEach((s, i) => {
      const d = s.status === 'fulfilled' ? s.value : null;
      if (d) out.set(pending[i].name.trim(), d);
      else stillPending.push(pending[i]);
    });
    pending = stillPending;
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
