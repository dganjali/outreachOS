// Serper client - optional. Active only when SERPER_API_KEY is set.
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

// ---------------------------------------------------------------------------
// LinkedIn SERP title parsing. A public LinkedIn result title is reliably shaped
// "Name - Title - Company | LinkedIn" (sometimes "Name - Title at Company" or,
// when there's no headline, just "Name - Company"). The verbatim title is a far
// better seniority signal than an LLM's free-text re-description, so we parse it
// deterministically and feed THAT to the scorer (CONTACT_ENGINE.md §3 - the role
// must be parsed, not paraphrased).
// ---------------------------------------------------------------------------

export interface ParsedLinkedinTitle {
  name: string | null;
  role: string | null;
  company: string | null;
}

// Words that mark a fragment as a role rather than a company, so the ambiguous
// two-part "Name - X" case ("Name - Director" vs "Name - Acme") resolves right.
const ROLE_HINT =
  /\b(manager|director|head|lead|chief|officer|president|vp|vice president|founder|partner|principal|staff|senior|sr\.?|specialist|associate|engineer|developer|analyst|recruiter|designer|scientist|researcher|consultant|coordinator|administrator|strategist|advisor|owner|investor|of|for)\b/i;

/** Parse a LinkedIn SERP result title into its name / role / company parts. */
export function parseLinkedinTitle(rawTitle: string): ParsedLinkedinTitle {
  const empty: ParsedLinkedinTitle = { name: null, role: null, company: null };
  if (!rawTitle || typeof rawTitle !== 'string') return empty;

  // Drop the "| LinkedIn" suffix and any "· Experience: …" / "- 500 connections"
  // trailing noise Google appends, then normalize separators.
  let t = rawTitle.split('|')[0].split('·')[0].trim();
  if (!t) return empty;

  const parts = t
    .split(/\s[-–—]\s/) // " - ", en/em dashes too
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return empty;

  const name = parts[0] || null;
  const rest = parts.slice(1);

  if (rest.length === 0) return { name, role: null, company: null };

  // 3+ parts: "Name - Role - Company [- extra]". Role is the first remainder,
  // company the next; ignore trailing fragments.
  if (rest.length >= 2) {
    return { name, role: rest[0] || null, company: rest[1] || null };
  }

  // Exactly one remainder: could be "Role at Company", just a role, or just a
  // company (no headline on the profile).
  const one = rest[0];
  const atSplit = one.split(/\s+\bat\b\s+/i);
  if (atSplit.length >= 2) {
    return { name, role: atSplit[0].trim() || null, company: atSplit.slice(1).join(' at ').trim() || null };
  }
  // No "at": treat as a role when it reads like a title, else as a company.
  return ROLE_HINT.test(one)
    ? { name, role: one, company: null }
    : { name, role: null, company: one };
}

/** True for an INDIVIDUAL LinkedIn profile URL (linkedin.com/in/<slug>), as
 *  opposed to a company/school/post/jobs/directory page. The discovery pool is
 *  meant to be people, so a fund's /company/ page (which is how "Fin Capital"
 *  style firms leak in) never reads as a person. Country subdomains
 *  (ca.linkedin.com, uk.linkedin.com) are individual profiles too. */
export function isLinkedinProfile(link: string): boolean {
  try {
    const u = new URL(link);
    return /(^|\.)linkedin\.com$/i.test(u.hostname) && /^\/in\/[^/]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

/** Normalize the profile URL so the same person from two queries dedupes. */
export function profileKey(link: string): string {
  try {
    const u = new URL(link);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  } catch {
    return link.trim().toLowerCase();
  }
}

/** Rotate an array by a seed so different target seeds pick a different subset
 *  when the list is longer than the slice cap. Pure + deterministic; seed=0 ⇒
 *  identity (preserves the un-seeded query strings exactly). */
export function seededRotate<T>(arr: T[], seed: number | undefined): T[] {
  if (!seed || arr.length <= 1) return arr;
  const k = seed % arr.length;
  return [...arr.slice(k), ...arr.slice(0, k)];
}

/** Build the focused query set for one target from its ICP. An optional seed
 *  rotates which function/seniority synonyms are used (when more exist than fit
 *  the query) so re-runs pull a partly different pool; omitted ⇒ deterministic. */
export function buildPeopleQueries(spec: PeopleQuerySpec, seed?: number): string[] {
  const company = `"${spec.companyName}"`;
  const fns = seededRotate(spec.functionKeywords, seed).slice(0, 6).map((t) => `"${t}"`);
  const funcClause = fns.length ? ` (${fns.join(' OR ')})` : '';
  const sen = seededRotate(spec.seniorityKeywords?.length ? spec.seniorityKeywords : SENIORITY_QUERY_DEFAULT, seed)
    .slice(0, 4)
    .map((t) => `"${t}"`);
  const senClause = sen.length ? ` (${sen.join(' OR ')})` : '';
  const neg = (spec.negativeTerms?.length ? spec.negativeTerms : NEGATIVE_DEFAULT)
    .slice(0, 6)
    .map((t) => `-${t}`)
    .join(' ');
  const negClause = neg ? ` ${neg}` : '';

  const queries: string[] = [];
  // 1. function × seniority, with negatives - the precise owner-band query.
  queries.push(`site:linkedin.com/in${funcClause}${senClause} ${company}${negClause}`.trim());
  // 2. function-only, NO negatives - a broad net so an oddly-titled or
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
export async function searchPeoplePool(spec: PeopleQuerySpec, numPerQuery = 8, seed?: number): Promise<SerperOrganicResult[]> {
  return runQueryPool(buildPeopleQueries(spec, seed), numPerQuery);
}

// ---------------------------------------------------------------------------
// Company-LESS people discovery ("find people" mode). Same LinkedIn-scoped
// approach as buildPeopleQueries, but with NO company clause: the person IS the
// target, found by function/seniority/sector/geo across any company. The agent
// then resolves each person's current company downstream.
// ---------------------------------------------------------------------------

export interface OpenPeopleQuerySpec {
  functionKeywords: string[]; // ICP function synonyms - the primary signal
  seniorityKeywords?: string[]; // optional; omitted ⇒ functions carry the query
  sectorTerms?: string[]; // optional sector/industry bias
  negativeTerms?: string[]; // e.g. ["student", "intern", "former"]
  geo?: string | null; // location term appended on one variant
}

/** Build the focused, company-less query set from the open-people spec. */
export function buildOpenPeopleQueries(spec: OpenPeopleQuerySpec): string[] {
  const fns = spec.functionKeywords.slice(0, 6).map((t) => `"${t}"`);
  const funcClause = fns.length ? ` (${fns.join(' OR ')})` : '';
  // No seniority default here: open search trusts the function terms, so an
  // empty list means "don't constrain seniority" (unlike the company variant).
  const sen = (spec.seniorityKeywords ?? []).slice(0, 4).map((t) => `"${t}"`);
  const senClause = sen.length ? ` (${sen.join(' OR ')})` : '';
  const neg = (spec.negativeTerms ?? []).slice(0, 6).map((t) => `-${t}`).join(' ');
  const negClause = neg ? ` ${neg}` : '';

  const queries: string[] = [];
  // 1. function (× seniority) - the precise profile query.
  queries.push(`site:linkedin.com/in${funcClause}${senClause}${negClause}`.trim());
  // 2. function × sector - bias toward where they work, when sectors are given.
  if (spec.sectorTerms?.length) {
    const sectors = spec.sectorTerms.slice(0, 4).map((t) => `"${t}"`).join(' OR ');
    queries.push(`site:linkedin.com/in${funcClause} (${sectors})${negClause}`.trim());
  }
  // 3. geo variant of the precise query, when a location focus is set.
  if (spec.geo && spec.geo.trim()) {
    queries.push(`site:linkedin.com/in${funcClause}${senClause} "${spec.geo.trim()}"${negClause}`.trim());
  }
  return [...new Set(queries)];
}

/** Run the open-people query set and return a deduped, merged result pool. */
export async function searchOpenPeoplePool(spec: OpenPeopleQuerySpec, numPerQuery = 10): Promise<SerperOrganicResult[]> {
  return runQueryPool(buildOpenPeopleQueries(spec), numPerQuery);
}

/** Shared best-effort runner: merge + dedupe by profile URL; throw only if every
 *  query fails (so the caller's web_search fallback still triggers). */
async function runQueryPool(queries: string[], numPerQuery: number): Promise<SerperOrganicResult[]> {
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
      if (!isLinkedinProfile(r.link)) continue; // people only - never a firm/company page
      const key = profileKey(r.link);
      if (seen.has(key)) continue;
      seen.add(key);
      pool.push(r);
    }
  }
  return pool;
}
