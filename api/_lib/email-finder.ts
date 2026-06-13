// emailfinder.dev client — optional. Active only when EMAILFINDER_API_KEY is set.
// Real-time SMTP-verified email resolution: given a person's name + company
// domain, returns a deliverable email or null. Charged only when a valid email
// is found (misses are free). Docs: https://www.emailfinder.dev/reference
//
// This is a dumb provider client (mirrors apollo.ts). The cascade that decides
// when to call it lives in email-resolver.ts.

const BASE = 'https://www.emailfinder.dev/api';

export function emailFinderEnabled(): boolean {
  return !!process.env.EMAILFINDER_API_KEY;
}

async function emailFinderGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = process.env.EMAILFINDER_API_KEY;
  if (!key) throw new Error('email_finder_not_configured');
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* fallthrough — non-JSON body handled by !res.ok below or defensive parse */
  }
  if (!res.ok) {
    const detail =
      (payload as { error?: string; message?: string } | null)?.message ??
      (payload as { error?: string } | null)?.error ??
      text.slice(0, 300);
    throw new Error(`email_finder_${res.status}: ${detail}`);
  }
  return payload as T;
}

// Basic email shape check. The provider already SMTP-verifies; this only guards
// against a malformed/placeholder string sneaking through as a "found" email.
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Defensively extract the resolved email from an unknown-shaped response body.
 * The provider's full schema is unconfirmed, so a present, well-formed
 * `valid_email` is treated as the only success signal. Returns null otherwise.
 */
export function parseFindEmailResponse(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as Record<string, unknown>).valid_email;
  if (typeof v !== 'string') return null;
  const email = v.trim().toLowerCase();
  if (!email || !EMAIL_SHAPE.test(email)) return null;
  return email;
}

/**
 * Look up a verified email for a person. Never throws — logs and returns
 * { email: null } on any failure so the resolver cascade can continue.
 */
export async function findEmail(args: {
  fullName: string;
  domain: string;
}): Promise<{ email: string | null; raw: unknown }> {
  const { fullName, domain } = args;
  if (!fullName.trim() || !domain.trim()) return { email: null, raw: null };
  try {
    const raw = await emailFinderGet<unknown>('/find-email/person', {
      full_name: fullName,
      domain,
    });
    return { email: parseFindEmailResponse(raw), raw };
  } catch (err) {
    console.warn('email_finder_failed', fullName, domain, err);
    return { email: null, raw: null };
  }
}
