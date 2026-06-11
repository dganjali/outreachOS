// Resolve missing company domains (Gemini + web search) and scrape public emails.

import { createMessageWithRetry, MODEL, WEB_SEARCH_TOOL, extractJson } from './anthropic';
import { normalizeDomain } from './sender-context';
import {
  scrapeCompanyEmails,
  matchEmailForPerson,
  emailFromPattern,
  type ScrapeResult,
} from './web-scrape';

interface DomainLookupRow {
  company_name: string;
  domain: string;
}

/** Batch-resolve official website domains for companies missing one. */
export async function resolveCompanyDomains(
  companies: Array<{ name: string; hint?: string }>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (companies.length === 0) return out;

  const list = companies.slice(0, 12).map((c, i) => ({
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

export interface ContactEmailFields {
  email: string | null;
  emailStatus: 'verified' | 'likely' | 'guessed' | 'none';
  likelyEmailPattern: string | null;
}

export function enrichContactEmail(
  name: string,
  existing: ContactEmailFields,
  domain: string,
  scraped: ScrapeResult
): ContactEmailFields {
  if (existing.email) return existing;

  const match = matchEmailForPerson(name, scraped.emails, domain);
  if (match.email) {
    const pattern = scraped.pattern ? `${scraped.pattern}@${domain}` : existing.likelyEmailPattern;
    return {
      email: match.email,
      emailStatus: match.status,
      likelyEmailPattern: pattern,
    };
  }

  const patternStr = scraped.pattern
    ? `${scraped.pattern}@${domain}`
    : existing.likelyEmailPattern ?? `first.last@${domain}`;

  const guessed = emailFromPattern(scraped.pattern ?? 'first.last', name, domain);
  if (guessed) {
    return { email: guessed, emailStatus: 'guessed', likelyEmailPattern: patternStr };
  }

  return {
    email: null,
    emailStatus: 'none',
    likelyEmailPattern: patternStr,
  };
}
