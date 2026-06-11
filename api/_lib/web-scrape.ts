// Lightweight public-web scraping for company domains and contact emails.
// Fetches a handful of common paths and extracts mailto:/regex emails.

const FETCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; OutreachOS/1.0; +https://outreachos.app) AppleWebKit/537.36';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

const JUNK_LOCAL = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'mailer-daemon',
  'postmaster',
  'webmaster',
  'support',
  'help',
  'info',
  'hello',
  'contact',
  'sales',
  'press',
  'media',
  'privacy',
  'legal',
  'abuse',
  'admin',
]);

const JUNK_DOMAINS = new Set([
  'example.com',
  'email.com',
  'domain.com',
  'sentry.io',
  'wixpress.com',
  'cloudflare.com',
  'schema.org',
]);

export interface ScrapeResult {
  domain: string;
  emails: string[];
  pattern: string | null;
  pagesScraped: string[];
}

export async function fetchPageText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('text/plain')) return null;
    const text = await res.text();
    return text.slice(0, 500_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function extractEmailsFromHtml(html: string, domain?: string): string[] {
  const found = new Set<string>();

  for (const m of html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)) {
    addEmail(found, m[1], domain);
  }

  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  for (const m of stripped.matchAll(EMAIL_RE)) {
    addEmail(found, m[0], domain);
  }

  return [...found];
}

function addEmail(set: Set<string>, raw: string, domain?: string) {
  const email = raw.trim().toLowerCase();
  if (!email.includes('@')) return;
  const [local, host] = email.split('@');
  if (!local || !host || JUNK_DOMAINS.has(host)) return;
  if (local.includes('..') || email.length > 80) return;
  if (domain && host !== domain && !host.endsWith(`.${domain}`)) {
    // Keep only emails on the company domain (skip CDN/social noise).
    if (!host.includes(domain.split('.')[0] ?? '')) return;
  }
  if (JUNK_LOCAL.has(local)) return;
  set.add(email);
}

export function inferEmailPattern(emails: string[]): string | null {
  const personEmails = emails.filter((e) => {
    const local = e.split('@')[0] ?? '';
    return local.includes('.') && !JUNK_LOCAL.has(local);
  });
  if (personEmails.length < 1) return null;

  const samples = personEmails.slice(0, 6).map((e) => e.split('@')[0] ?? '');
  if (samples.every((s) => /^[a-z]+\.[a-z]+$/.test(s))) return 'first.last';
  if (samples.every((s) => /^[a-z][a-z]+$/.test(s))) return 'firstlast';
  if (samples.every((s) => /^[a-z]\.[a-z]+$/.test(s))) return 'f.last';
  if (samples.every((s) => /^[a-z]+_[a-z]+$/.test(s))) return 'first_last';
  return 'first.last';
}

export function emailFromPattern(pattern: string, name: string, domain: string): string | null {
  const parts = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return null;
  const first = parts[0].replace(/[^a-z]/g, '');
  const last = parts[parts.length - 1].replace(/[^a-z]/g, '');
  if (!first || !last) return null;

  let local: string;
  switch (pattern) {
    case 'first.last':
      local = `${first}.${last}`;
      break;
    case 'firstlast':
      local = `${first}${last}`;
      break;
    case 'f.last':
      local = `${first[0]}.${last}`;
      break;
    case 'first_last':
      local = `${first}_${last}`;
      break;
    default:
      local = `${first}.${last}`;
  }
  return `${local}@${domain}`;
}

export function matchEmailForPerson(
  name: string,
  emails: string[],
  domain: string
): { email: string | null; status: 'verified' | 'likely' | 'guessed' } {
  const parts = name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 1) return { email: null, status: 'guessed' };

  const first = parts[0].replace(/[^a-z]/g, '');
  const last = (parts[parts.length - 1] ?? '').replace(/[^a-z]/g, '');

  for (const email of emails) {
    const local = (email.split('@')[0] ?? '').toLowerCase();
    const onDomain = email.endsWith(`@${domain}`);
    if (!onDomain) continue;

    if (parts.length >= 2) {
      if (local === `${first}.${last}` || local === `${first}${last}` || local === `${first}_${last}`) {
        return { email, status: 'verified' };
      }
      if (local.includes(first) && local.includes(last)) {
        return { email, status: 'verified' };
      }
    } else if (local.includes(first)) {
      return { email, status: 'likely' };
    }
  }

  const pattern = inferEmailPattern(emails);
  if (pattern && parts.length >= 2) {
    const guessed = emailFromPattern(pattern, name, domain);
    if (guessed) return { email: guessed, status: 'likely' };
  }

  if (parts.length >= 2) {
    return { email: emailFromPattern('first.last', name, domain), status: 'guessed' };
  }
  return { email: null, status: 'guessed' };
}

const COMMON_PATHS = ['', '/about', '/about-us', '/team', '/people', '/company', '/contact', '/contact-us'];

export async function scrapeCompanyEmails(domain: string): Promise<ScrapeResult> {
  const pagesScraped: string[] = [];
  const allEmails = new Set<string>();

  const bases = [`https://${domain}`, `https://www.${domain}`];
  for (const base of bases) {
    for (const path of COMMON_PATHS) {
      const url = `${base}${path}`;
      const html = await fetchPageText(url);
      if (!html) continue;
      pagesScraped.push(url);
      for (const e of extractEmailsFromHtml(html, domain)) allEmails.add(e);
      if (allEmails.size >= 12) break;
    }
    if (allEmails.size >= 8) break;
  }

  const emails = [...allEmails];
  return {
    domain,
    emails,
    pattern: inferEmailPattern(emails),
    pagesScraped,
  };
}
