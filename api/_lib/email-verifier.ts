// MillionVerifier client - optional. Active only when MILLIONVERIFIER_API_KEY
// is set. A catch-all gate that runs after email resolution: given a candidate
// email it returns a trust verdict so a finder hit on a catch-all domain (which
// accepts ANY address at SMTP) isn't over-trusted as 'verified'. Charged per
// check (prepaid, never-expire credits). Docs: https://millionverifier.com/api
//
// Like email-finder.ts this is a dumb client (the cascade that decides when to
// call it lives in email-resolver.ts) and it NEVER throws - on any outage it
// returns 'verified' so a verifier hiccup can't discard otherwise-good emails.

const BASE = 'https://api.millionverifier.com/api/v3/';

// Our trust verdict, aligned with EmailStatus minus 'guessed'/'none'.
export type VerifyVerdict = 'verified' | 'likely' | 'invalid';

export function verifierEnabled(): boolean {
  return !!process.env.MILLIONVERIFIER_API_KEY;
}

/**
 * Map MillionVerifier's `result` string to a trust verdict:
 *   ok                    -> verified (mailbox confirmed deliverable)
 *   invalid | disposable  -> invalid  (discard - not a real mailbox)
 *   catch_all | unknown   -> likely   (domain accepts anything; can't confirm)
 *   error | anything else -> verified (verifier couldn't decide - e.g. HTTP 200
 *                            with `result:"error"` / "Insufficient credits" -
 *                            so treat it as an outage and TRUST the finder hit
 *                            rather than silently downgrading every email).
 * Only the two confirmed-bad verdicts ever discard; only the two unconfirmable
 * verdicts ever downgrade. Everything else falls back to the finder's own SMTP
 * check, matching verifyEmail's outage behavior.
 */
export function mapResult(result: unknown): VerifyVerdict {
  const r = typeof result === 'string' ? result.toLowerCase() : '';
  switch (r) {
    case 'ok':
      return 'verified';
    case 'invalid':
    case 'disposable':
      return 'invalid';
    case 'catch_all':
    case 'unknown':
      return 'likely';
    default:
      return 'verified';
  }
}

/** Defensively pull the verdict out of an unknown-shaped response body. */
export function parseVerifyResponse(raw: unknown): VerifyVerdict {
  if (!raw || typeof raw !== 'object') return 'verified';
  const body = raw as Record<string, unknown>;
  // `result: "error"` (HTTP 200) signals a verifier-side failure - most often an
  // out-of-credits account. Surface it so it's visible in logs, then fall back.
  if (body.result === 'error') {
    console.warn('email_verifier_result_error', body.error ?? 'unknown', 'credits=', body.credits ?? '?');
  }
  return mapResult(body.result);
}

/**
 * Verify a candidate email. Never throws. On any outage (HTTP/parse failure) we
 * fall back to 'verified' so a verifier outage doesn't empty out targets by
 * discarding good finder hits.
 */
export async function verifyEmail(email: string): Promise<VerifyVerdict> {
  const key = process.env.MILLIONVERIFIER_API_KEY;
  if (!key || !email.trim()) return 'verified';
  try {
    const url = `${BASE}?${new URLSearchParams({ api: key, email }).toString()}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      /* fallthrough - outage fallback below */
    }
    if (!res.ok) {
      console.warn('email_verifier_http', res.status, text.slice(0, 200));
      return 'verified';
    }
    return parseVerifyResponse(payload);
  } catch (err) {
    // Log the domain only - never the full address (PII in logs; checklist #35).
    console.warn('email_verifier_failed', email.split('@')[1] ?? 'unknown', err);
    return 'verified';
  }
}
