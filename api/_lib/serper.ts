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
