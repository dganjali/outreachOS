// Email-resolution cascade — provider-agnostic. Turns a discovered person
// (name) + company domain into a trustworthy email, or nothing.
//
// The whole point: we NEVER ship an unverified pattern-guess (e.g.
// first.last@domain) as a usable email. A contact only gets an `email` when it
// is verified by an external finder (emailfinder.dev) or actually appears on
// the company's own site. Otherwise email stays null and we keep a
// `likelyEmailPattern` for display only.
//
// Providers are injectable so the cascade is unit-testable with fakes and so we
// can swap emailfinder.dev for Anymailfinder / EmailAPI.ai / DeBounce later
// without touching the contacts handler.

import { matchEmailForPerson, type ScrapeResult } from './web-scrape';
import { emailFinderEnabled, findEmail } from './email-finder';
import { verifierEnabled, verifyEmail, type VerifyVerdict } from './email-verifier';

export type EmailStatus = 'verified' | 'likely' | 'guessed' | 'none';

export interface ContactEmailFields {
  email: string | null;
  emailStatus: EmailStatus;
  likelyEmailPattern: string | null;
}

export interface ResolvedEmail extends ContactEmailFields {
  // Which rung of the cascade produced this result (persisted as
  // ContactDoc.emailResolver for analytics). 'verifier' means a finder hit that
  // passed through the MillionVerifier gate; 'preexisting' means a trusted email
  // already on the row (e.g. a CSV/manual import). ContactDoc.source still
  // describes how the *person* was discovered.
  resolver: 'preexisting' | 'email_finder' | 'scrape' | 'verifier' | 'none';
}

// A provider maps (name, domain) -> verified email or null.
export interface EmailProvider {
  enabled(): boolean;
  findEmail(args: { fullName: string; domain: string }): Promise<{ email: string | null; raw: unknown }>;
}

// A verifier gates a candidate email: confirm, downgrade, or reject. Injectable
// so the cascade is unit-testable with a fake and so MillionVerifier can be
// swapped for DeBounce later without touching the contacts handler.
export interface EmailVerifier {
  enabled(): boolean;
  verify(email: string): Promise<VerifyVerdict>;
}

const emailFinderProvider: EmailProvider = {
  enabled: emailFinderEnabled,
  findEmail,
};

const millionVerifier: EmailVerifier = {
  enabled: verifierEnabled,
  verify: verifyEmail,
};

export const DEFAULT_PROVIDERS: EmailProvider[] = [emailFinderProvider];
export const DEFAULT_VERIFIER: EmailVerifier = millionVerifier;

function displayPattern(domain: string, existing: ContactEmailFields, scraped: ScrapeResult): string | null {
  if (scraped.pattern) return `${scraped.pattern}@${domain}`;
  return existing.likelyEmailPattern ?? null;
}

/**
 * Resolve a deliverable email for `name` at `domain`. Ordered cascade:
 *   1. A pre-trusted email already on the row (verified/likely import) — keep.
 *   2. External finder providers (emailfinder.dev) — SMTP-verified hit.
 *   3. A real email scraped from the company site that matches this person.
 *   4. Nothing → email:null, status 'none', pattern kept for display only.
 */
export async function resolveEmail(
  name: string,
  domain: string,
  existing: ContactEmailFields,
  scraped: ScrapeResult,
  providers: EmailProvider[] = DEFAULT_PROVIDERS,
  verifier: EmailVerifier = DEFAULT_VERIFIER,
): Promise<ResolvedEmail> {
  const pattern = displayPattern(domain, existing, scraped);

  // 1. Trust an email that already arrived verified/likely (e.g. a CSV/manual
  //    import). 'guessed'/'none' rows fall through to be re-resolved below.
  if (existing.email && (existing.emailStatus === 'verified' || existing.emailStatus === 'likely')) {
    return { email: existing.email, emailStatus: existing.emailStatus, likelyEmailPattern: pattern, resolver: 'preexisting' };
  }

  if (!domain) {
    return { email: null, emailStatus: 'none', likelyEmailPattern: pattern, resolver: 'none' };
  }

  // 2. External, SMTP-verified finders, gated by the verifier (catch-all check).
  for (const provider of providers) {
    if (!provider.enabled()) continue;
    const { email } = await provider.findEmail({ fullName: name, domain });
    if (!email) continue;
    // Verifier gate: 'verified' as-is, catch-all/unknown -> 'likely', 'invalid'
    // -> discard and keep looking down the cascade. When the verifier is off we
    // trust the finder's own SMTP check (status 'verified').
    if (verifier.enabled()) {
      const verdict = await verifier.verify(email);
      if (verdict === 'invalid') continue;
      return { email, emailStatus: verdict, likelyEmailPattern: pattern, resolver: 'verifier' };
    }
    return { email, emailStatus: 'verified', likelyEmailPattern: pattern, resolver: 'email_finder' };
  }

  // 3. A real email harvested from the company site that maps to this person.
  //    matchEmailForPerson also has a pattern-GUESS fallback; we discard that by
  //    only trusting a result that is actually present in the scraped set.
  if (name.trim() && scraped.emails.length > 0) {
    const m = matchEmailForPerson(name, scraped.emails, domain);
    if (m.email && scraped.emails.includes(m.email)) {
      const status: EmailStatus = m.status === 'verified' ? 'verified' : 'likely';
      return { email: m.email, emailStatus: status, likelyEmailPattern: pattern, resolver: 'scrape' };
    }
  }

  // 4. Nothing trustworthy. Keep the pattern for display; never ship a guess.
  return { email: null, emailStatus: 'none', likelyEmailPattern: pattern, resolver: 'none' };
}
