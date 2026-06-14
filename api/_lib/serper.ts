// Serper client — optional. Active only when SERPER_API_KEY is set.
// A deterministic Google SERP API used for person discovery: we run
// LinkedIn-scoped queries and hand the organic results to the LLM to rank.
// This replaces the LLM's opaque built-in web_search grounding for discovery.
// Docs: https://serper.dev

const BASE = 'https://google.serper.dev';

export function serperEnabled(): boolean {
  return !!process.env.SERPER_API_KEY;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
}

async function serperPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error('serper_not_configured');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'X-API-KEY': key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* fallthrough */
  }
  if (!res.ok) {
    const detail =
      (payload as { message?: string } | null)?.message ?? text.slice(0, 300);
    throw new Error(`serper_${res.status}: ${detail}`);
  }
  return payload as T;
}

/** Defensively pull the organic results out of an unknown-shaped response. */
export function parseOrganic(raw: unknown): SerperOrganicResult[] {
  if (!raw || typeof raw !== 'object') return [];
  const organic = (raw as Record<string, unknown>).organic;
  if (!Array.isArray(organic)) return [];
  return organic
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o) => ({
      title: typeof o.title === 'string' ? o.title : '',
      link: typeof o.link === 'string' ? o.link : '',
      snippet: typeof o.snippet === 'string' ? o.snippet : '',
    }))
    .filter((o) => o.link);
}

/**
 * Build a LinkedIn-scoped people-discovery query from a company name and the
 * mode's title hints, e.g.
 *   site:linkedin.com/in ("developer relations" OR "partnerships") "Acme"
 */
export function buildPeopleQuery(companyName: string, titleHints: string[]): string {
  const titles = titleHints
    .slice(0, 6)
    .map((t) => `"${t}"`)
    .join(' OR ');
  const titleClause = titles ? ` (${titles})` : '';
  return `site:linkedin.com/in${titleClause} "${companyName}"`;
}

/** Run a raw Google search. Throws on failure (callers fall back). */
export async function search(query: string, num = 10): Promise<SerperOrganicResult[]> {
  const raw = await serperPost<unknown>('/search', { q: query, num });
  return parseOrganic(raw);
}

/** Discover likely people at a company via a LinkedIn-scoped query. */
export async function searchPeople(
  companyName: string,
  titleHints: string[],
  num = 10,
): Promise<SerperOrganicResult[]> {
  return search(buildPeopleQuery(companyName, titleHints), num);
}

// ---------------------------------------------------------------------------
// ICP-driven multi-query discovery (CONTACT_ENGINE.md §4). Instead of one big
// OR-blob, build a small set of focused queries (functions × seniority
// keywords), each with negative terms that knock out the obvious "too senior"
// misses, plus a geo variant. Results are merged and deduped by profile URL.
// ---------------------------------------------------------------------------

export interface PeopleQuerySpec {
  companyName: string;
  functionKeywords: string[]; // ICP function synonyms
  seniorityKeywords?: string[]; // e.g. ["manager", "director"]
  negativeTerms?: string[]; // e.g. ["president", "chief", "vp"]
  geo?: string | null; // location term to append on one variant
}

const SENIORITY_QUERY_DEFAULT = ['manager', 'director', 'lead'];
const NEGATIVE_DEFAULT = ['president', 'chief', 'cmo', 'cfo', 'cto', 'ceo'];

/** Normalize the profile URL so the same person from two queries dedupes. */
export function profileKey(link: string): string {
  try {
    const u = new URL(link);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return link.trim().toLowerCase();
  }
}

/** Build the focused query set for one target from its ICP. */
export function buildPeopleQueries(spec: PeopleQuerySpec): string[] {
  const company = `"${spec.companyName}"`;
  const fns = spec.functionKeywords.slice(0, 6).map((t) => `"${t}"`);
  const funcClause = fns.length ? ` (${fns.join(' OR ')})` : '';
  const sen = (spec.seniorityKeywords?.length ? spec.seniorityKeywords : SENIORITY_QUERY_DEFAULT)
    .slice(0, 4)
    .map((t) => `"${t}"`);
  const senClause = sen.length ? ` (${sen.join(' OR ')})` : '';
  const neg = (spec.negativeTerms?.length ? spec.negativeTerms : NEGATIVE_DEFAULT)
    .slice(0, 6)
    .map((t) => `-${t}`)
    .join(' ');
  const negClause = neg ? ` ${neg}` : '';

  const queries: string[] = [];
  // 1. function × seniority, with negatives — the precise owner-band query.
  queries.push(`site:linkedin.com/in${funcClause}${senClause} ${company}${negClause}`.trim());
  // 2. function-only, NO negatives — a broad net so an oddly-titled or
  //    on-function senior owner still appears; the scorer ranks them, not the query.
  queries.push(`site:linkedin.com/in${funcClause} ${company}`.trim());
  // 3. geo variant of the precise query, when a location focus is set.
  if (spec.geo && spec.geo.trim()) {
    queries.push(`site:linkedin.com/in${funcClause}${senClause} ${company} "${spec.geo.trim()}"${negClause}`.trim());
  }
  // Dedupe identical strings (e.g. empty function clause collapses 1 and 2).
  return [...new Set(queries)];
}

/**
 * Run the ICP query set and return a deduped, merged result pool. Each query is
 * best-effort; a single failure doesn't sink the others. Throws only if EVERY
 * query throws (so the caller's web_search fallback still triggers).
 */
export async function searchPeoplePool(spec: PeopleQuerySpec, numPerQuery = 8): Promise<SerperOrganicResult[]> {
  const queries = buildPeopleQueries(spec);
  const settled = await Promise.allSettled(queries.map((q) => search(q, numPerQuery)));
  if (settled.every((s) => s.status === 'rejected')) {
    const first = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult | undefined;
    throw first?.reason ?? new Error('serper_pool_failed');
  }
  const seen = new Set<string>();
  const pool: SerperOrganicResult[] = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const r of s.value) {
      const key = profileKey(r.link);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(r);
    }
  }
  return pool;
}
