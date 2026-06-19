// Deterministic content lint for outgoing email - the first, free pass of the
// deliverability layer. Catches the spam-filter and "obviously broken" signals
// that hurt the sender's reputation, without any network call. The LLM
// moderation pass (content-moderation.ts) handles abuse/policy on top.
//
// Severity contract:
//   'block' - never send as-is (broken merge tags, empty body, blatant spam).
//   'warn'  - allowed on a manual send (with a heads-up); Autopilot routes these
//             to human review instead of auto-sending.
//   'ok'    - clean.
// Pure and side-effect-free so it is exhaustively unit-testable.

export type LintSeverity = 'ok' | 'warn' | 'block';

export interface LintIssue {
  code: string;
  severity: 'warn' | 'block';
  message: string;
}

export interface LintResult {
  severity: LintSeverity;
  score: number; // summed spam weight (diagnostic only)
  issues: LintIssue[];
}

// Spam trigger phrases with rough weights. Not exhaustive - the worst offenders
// that classifiers and humans both read as bulk/scam. Matched case-insensitively
// as word-ish substrings.
const SPAM_PHRASES: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bact now\b/i, weight: 2, label: 'act now' },
  { re: /\blimited time\b/i, weight: 2, label: 'limited time' },
  { re: /\brisk[- ]?free\b/i, weight: 2, label: 'risk-free' },
  { re: /\b100%\s*(free|satisfied|guaranteed)\b/i, weight: 3, label: '100% free/guaranteed' },
  { re: /\bclick here\b/i, weight: 2, label: 'click here' },
  { re: /\bbuy now\b/i, weight: 2, label: 'buy now' },
  { re: /\border now\b/i, weight: 2, label: 'order now' },
  { re: /\bcongratulations\b/i, weight: 2, label: 'congratulations' },
  { re: /\byou('| a)re a winner\b/i, weight: 3, label: 'winner' },
  { re: /\bfree (gift|money|trial|access)\b/i, weight: 2, label: 'free offer' },
  { re: /\bguarantee(d)?\b/i, weight: 1, label: 'guarantee' },
  { re: /\bcash bonus\b/i, weight: 3, label: 'cash bonus' },
  { re: /\bno (cost|obligation|catch)\b/i, weight: 2, label: 'no cost/obligation' },
  { re: /\bearn \$/i, weight: 3, label: 'earn $' },
  { re: /\bmake money\b/i, weight: 2, label: 'make money' },
  { re: /\burgent\b/i, weight: 1, label: 'urgent' },
  { re: /\bdouble your\b/i, weight: 2, label: 'double your' },
  { re: /\bspecial promotion\b/i, weight: 2, label: 'special promotion' },
  { re: /\bunsubscribe\b/i, weight: 1, label: 'unsubscribe wording' },
];

// Unfilled personalization placeholders left in the text. These should NEVER go
// out - "Hi {{first_name}}" screams automation and breaks trust instantly.
const MERGE_TAG_PATTERNS: RegExp[] = [
  /\{\{[^}]+\}\}/, // {{first_name}}
  /\{[a-z_][a-z0-9_]*\}/i, // {first_name}
  /\[\[[^\]]+\]\]/, // [[company]]
  /<(first|last|full)[ _-]?name>/i, // <first name>
  /\b(FIRSTNAME|LASTNAME|FULLNAME|COMPANYNAME)\b/, // FIRSTNAME
  /%[A-Z_]+%/, // %FIRST_NAME%
];

const URL_RE = /\bhttps?:\/\/[^\s<>()]+/gi;
const SHORTENER_RE = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly)\b/i;

const MAX_LINKS = 4; // more than this in a 1:1 email reads as bulk
const MIN_BODY_CHARS = 40;
const MAX_BODY_CHARS = 5000;

export function lintContent(input: { subject: string; body: string }): LintResult {
  const subject = (input.subject ?? '').trim();
  const body = (input.body ?? '').trim();
  const issues: LintIssue[] = [];
  let score = 0;

  // --- hard blocks ---------------------------------------------------------
  if (!subject) issues.push({ code: 'no_subject', severity: 'block', message: 'Subject is empty.' });
  if (!body) issues.push({ code: 'no_body', severity: 'block', message: 'Body is empty.' });

  const text = `${subject}\n${body}`;
  for (const re of MERGE_TAG_PATTERNS) {
    const m = text.match(re);
    if (m) {
      issues.push({
        code: 'unfilled_merge_tag',
        severity: 'block',
        message: `Looks like an unfilled placeholder ("${m[0]}"). Replace it before sending.`,
      });
      break;
    }
  }

  if (subject && subject.length >= 8 && subject === subject.toUpperCase() && /[A-Z]/.test(subject)) {
    issues.push({ code: 'allcaps_subject', severity: 'block', message: 'Subject is in ALL CAPS.' });
  }

  const urls = body.match(URL_RE) ?? [];
  if (urls.length > MAX_LINKS) {
    issues.push({
      code: 'too_many_links',
      severity: 'block',
      message: `${urls.length} links in one email reads as bulk. Keep it to ${MAX_LINKS} or fewer.`,
    });
  }
  if (urls.some((u) => SHORTENER_RE.test(u))) {
    issues.push({
      code: 'link_shortener',
      severity: 'block',
      message: 'Shortened links (bit.ly, etc.) are a strong spam signal. Use the full URL.',
    });
  }

  // --- spam-phrase density -------------------------------------------------
  const hits: string[] = [];
  for (const p of SPAM_PHRASES) {
    if (p.re.test(text)) {
      score += p.weight;
      hits.push(p.label);
    }
  }
  if (score >= 6) {
    issues.push({
      code: 'spam_phrases_high',
      severity: 'block',
      message: `Multiple strong spam phrases (${hits.slice(0, 4).join(', ')}). Rewrite to sound personal.`,
    });
  } else if (score >= 3) {
    issues.push({
      code: 'spam_phrases',
      severity: 'warn',
      message: `Some spammy phrasing (${hits.slice(0, 4).join(', ')}). Consider rewording.`,
    });
  }

  // --- softer warnings -----------------------------------------------------
  if (body && body.length < MIN_BODY_CHARS) {
    issues.push({ code: 'body_too_short', severity: 'warn', message: 'Body is very short; it may look like spam.' });
  }
  if (body.length > MAX_BODY_CHARS) {
    issues.push({ code: 'body_too_long', severity: 'warn', message: 'Body is very long; cold emails do best under ~150 words.' });
  }
  const exclam = (body.match(/!/g) ?? []).length;
  if (exclam >= 3) issues.push({ code: 'excess_exclaim', severity: 'warn', message: 'Lots of exclamation marks reads as hype.' });
  if (/\${2,}|\$\d[\d,]*\b.*\bfree\b/i.test(text)) {
    issues.push({ code: 'money_hype', severity: 'warn', message: 'Money + "free" phrasing is a classic spam pattern.' });
  }
  const capsWords = body.match(/\b[A-Z]{4,}\b/g) ?? [];
  if (capsWords.length >= 3) {
    issues.push({ code: 'shouting', severity: 'warn', message: 'Several ALL-CAPS words; lowercase reads more personal.' });
  }
  if (/^\s*(re|fwd)\s*:/i.test(subject)) {
    issues.push({ code: 'fake_reply_subject', severity: 'warn', message: 'Faking "Re:/Fwd:" in a first email erodes trust.' });
  }
  if (countEmoji(text) >= 4) {
    issues.push({ code: 'emoji_overload', severity: 'warn', message: 'Heavy emoji use looks promotional.' });
  }

  const severity: LintSeverity = issues.some((i) => i.severity === 'block')
    ? 'block'
    : issues.length
      ? 'warn'
      : 'ok';
  return { severity, score, issues };
}

function countEmoji(s: string): number {
  // Rough: count surrogate-pair / pictographic code points.
  const m = s.match(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu);
  return m ? m.length : 0;
}
