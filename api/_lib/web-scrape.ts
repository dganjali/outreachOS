// Lightweight public-web scraping for company domains and contact emails.
// Fetches a handful of common paths and extracts mailto:/regex emails.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const FETCH_TIMEOUT_MS = 6_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; OutreachOS/1.0; +https://outreachos.app) AppleWebKit/537.36';

// Max redirect hops we follow manually (each hop is re-validated for SSRF).
const MAX_REDIRECTS = 4;

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

// ---------------------------------------------------------------------------
// SSRF guard.
//
// `domain` ultimately comes from a user-controlled target row (a user can POST
// any `domain` through the generic /api/data/targets route), and the scraper
// turns it into a server-side fetch. Without this guard, a caller could point
// the domain at internal infrastructure - link-local cloud metadata
// (169.254.169.254 / metadata.google.internal), RFC1918 ranges, loopback, or
// other internal-only services - and use the scraper as an SSRF proxy. The
// extracted-email response also gives a partial read-back channel.
//
// Defense: only ever connect to a host that resolves exclusively to public,
// routable IPs. We re-validate on every redirect hop (manual redirects), so a
// public domain can't 3xx-bounce the fetch onto an internal address, and we
// pin the connection to a pre-resolved public IP to close the DNS-rebinding
// window between our check and fetch's own resolution.
// ---------------------------------------------------------------------------

function ipv4ToParts(ip: string): number[] | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/** True for any IP we must never connect to (private, reserved, link-local…). */
function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const p = ipv4ToParts(ip);
    if (!p) return true; // unparseable → treat as unsafe
    const [a, b] = p;
    if (a === 0) return true; // 0.0.0.0/8 "this host"
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 192 && b === 0 && p[2] === 0) return true; // 192.0.0.0/24
    if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)
    return false;
  }
  if (family === 6) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v === '::1' || v === '::') return true; // loopback / unspecified
    if (v.startsWith('fe80')) return true; // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) - validate the embedded v4.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not a valid IP literal
}

/** Hostnames that must never be resolved/fetched regardless of DNS answer. */
function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata' || h === 'metadata.google.internal') return true;
  return false;
}

/**
 * Resolve `host` and confirm every answer is a public IP. Returns one resolved
 * public IP to pin the connection to (defeats DNS rebinding), or null if the
 * host is unsafe / unresolvable.
 */
async function resolvePublicHost(host: string): Promise<string | null> {
  if (!host || isBlockedHostname(host)) return null;
  // A bare IP literal in the URL: validate it directly.
  if (isIP(host)) return isPrivateIp(host) ? null : host;
  let records: Array<{ address: string }>;
  try {
    records = await lookup(host, { all: true });
  } catch {
    return null;
  }
  if (records.length === 0) return null;
  if (records.some((r) => isPrivateIp(r.address))) return null; // fail closed
  return records[0].address;
}

export async function fetchPageText(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return null;
      }
      // Only fetch over HTTP(S) - blocks file:, gopher:, ftp:, data:, etc.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

      const pinnedIp = await resolvePublicHost(parsed.hostname);
      if (!pinnedIp) return null;

      const res = await fetch(current, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });

      // Follow redirects ourselves so every hop is re-validated above.
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }

      if (!res.ok) return null;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html') && !ct.includes('text/plain')) return null;
      const text = await res.text();
      return text.slice(0, 500_000);
    }
    return null; // too many redirects
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap "does this domain serve a live page?" probe, reusing the same SSRF guard
 * + manual-redirect + timeout machinery as fetchPageText. Used by the company
 * domain-guess fallback to accept a guessed hostname only when it actually
 * resolves to a real site (2xx, or a 3xx that lands somewhere public). We GET
 * rather than HEAD because many hosts answer HEAD with 405; we never read the
 * body, so the cost is just headers. Returns false on any error/timeout.
 */
export async function isDomainLive(domain: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = `https://${domain}`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return false;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

      const pinnedIp = await resolvePublicHost(parsed.hostname);
      if (!pinnedIp) return false;

      const res = await fetch(current, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });

      // Re-validate each redirect hop (a public host could 3xx onto internal IP).
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return false;
        current = new URL(loc, current).toString();
        continue;
      }
      // A 2xx (or any non-redirect success-ish status < 400) means the host is up.
      return res.status < 400;
    }
    return false; // too many redirects
  } catch {
    return false;
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
  const allEmails = new Set<string>();

  // Fetch every (base × path) page CONCURRENTLY rather than one-at-a-time. The
  // sequential walk's early-out (`>= 12`/`>= 8` emails) only ever shaved a page
  // or two off a ~16-page crawl while paying full latency per page; firing them
  // all at once and merging the results is far faster and yields the same set.
  // allSettled so one dead/timed-out page never sinks the rest.
  const bases = [`https://${domain}`, `https://www.${domain}`];
  const urls = bases.flatMap((base) => COMMON_PATHS.map((path) => `${base}${path}`));
  const settled = await Promise.allSettled(urls.map((url) => fetchPageText(url)));

  // Merge in URL order so dedup/precedence is identical to the old serial walk.
  const pagesScraped: string[] = [];
  settled.forEach((s, idx) => {
    if (s.status !== 'fulfilled' || !s.value) return;
    pagesScraped.push(urls[idx]);
    for (const e of extractEmailsFromHtml(s.value, domain)) allEmails.add(e);
  });

  const emails = [...allEmails];
  return {
    domain,
    emails,
    pattern: inferEmailPattern(emails),
    pagesScraped,
  };
}
