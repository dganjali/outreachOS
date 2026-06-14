// Pure-heuristic deliverability check for cold emails. No LLM, no network, no
// browser/DOM deps — lives in shared/ so BOTH the frontend (pre-send warning)
// and the server engine (anti-slop verifier) use the exact same rules.

export type DeliverabilityLevel = 'good' | 'warn' | 'risk';

export interface DeliverabilityResult {
  score: number; // 0-100, higher = safer
  level: DeliverabilityLevel;
  warnings: string[];
}

const SPAM_WORDS = [
  'free', 'guarantee', 'act now', 'limited time', 'click here', 'buy now', 'cash',
  'winner', '100%', 'risk-free', 'urgent', 'offer expires', 'discount', 'cheap',
  'order now', 'congratulations', 'no obligation', 'call now', 'best price', 'earn $',
];

export function checkDeliverability(subject: string, body: string): DeliverabilityResult {
  const warnings: string[] = [];
  let penalty = 0;
  const text = `${subject}\n${body}`;
  const lower = text.toLowerCase();

  const hits = SPAM_WORDS.filter((w) => lower.includes(w));
  if (hits.length) {
    penalty += hits.length * 8;
    warnings.push(`Spam-trigger words: ${hits.slice(0, 4).join(', ')}${hits.length > 4 ? '…' : ''}`);
  }

  const links = (body.match(/https?:\/\/|www\./gi) ?? []).length;
  if (links > 2) {
    penalty += (links - 2) * 10;
    warnings.push(`${links} links. Cold emails do best with 0 or 1.`);
  }

  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words > 200) {
    penalty += 15;
    warnings.push(`${words} words. Cold emails under ~120 get more replies.`);
  } else if (words > 0 && words < 20) {
    penalty += 8;
    warnings.push('Very short. May read as low-effort.');
  }

  const caps = (text.match(/\b[A-Z]{4,}\b/g) ?? []).length;
  if (caps > 1) {
    penalty += caps * 5;
    warnings.push('ALL-CAPS words trip spam filters.');
  }

  const bangs = (text.match(/!/g) ?? []).length;
  if (bangs > 1) {
    penalty += bangs * 6;
    warnings.push(`${bangs} exclamation marks. Use at most one.`);
  }

  if (!subject.trim()) {
    penalty += 25;
    warnings.push('Missing subject line.');
  } else if (subject.length > 70) {
    penalty += 8;
    warnings.push('Subject is long. Aim for under ~50 characters.');
  }

  const score = Math.max(0, Math.min(100, 100 - penalty));
  const level: DeliverabilityLevel = score >= 80 ? 'good' : score >= 55 ? 'warn' : 'risk';
  return { score, level, warnings };
}
