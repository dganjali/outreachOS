// Sender-reputation throttle: a per-account daily cap that ramps as the Gmail
// connection ages (warmup), plus a per-recipient-domain sub-cap so one company
// never gets blasted. Pure - the caller supplies today's counts (derived from
// sent_messages) and the connection age. Send-only Gmail scope gives us no
// bounce feedback, so NOT spiking volume is our main reputation lever.

export interface SendAllowance {
  allowed: boolean;
  reason?: 'account_daily_cap' | 'domain_daily_cap';
  capToday: number;
  sentToday: number;
}

// Warmup ramp. A brand-new connection starts conservative and climbs each week
// to a steady ceiling. Tuned for cold 1:1 outreach, not bulk blasting.
const START_CAP = 25;
const WEEKLY_STEP = 25;
const CEILING = 250;
export const PER_DOMAIN_DAILY_CAP = 10;

/** Per-account daily send ceiling for a connection that's been live `ageDays`. */
export function warmupCap(ageDays: number): number {
  const weeks = Math.max(0, Math.floor((Number.isFinite(ageDays) ? ageDays : 0) / 7));
  return Math.min(CEILING, START_CAP + weeks * WEEKLY_STEP);
}

/** Whole days between `connectedAt` and `now` (>= 0). */
export function connectionAgeDays(connectedAt: Date | string | null | undefined, now: Date): number {
  if (!connectedAt) return 0;
  const t = new Date(connectedAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** Recipient domain, lowercased (the part after @). '' if unparseable. */
export function recipientDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

/**
 * Decide whether one more send fits the account's warmup cap and the
 * per-domain sub-cap. `sentToday` / `sentToDomainToday` are counts of sends
 * already made today (UTC day, the caller's convention).
 */
export function checkSendAllowance(args: {
  ageDays: number;
  sentToday: number;
  sentToDomainToday: number;
  perDomainCap?: number;
}): SendAllowance {
  const capToday = warmupCap(args.ageDays);
  const perDomainCap = args.perDomainCap ?? PER_DOMAIN_DAILY_CAP;
  if (args.sentToday >= capToday) {
    return { allowed: false, reason: 'account_daily_cap', capToday, sentToday: args.sentToday };
  }
  if (args.sentToDomainToday >= perDomainCap) {
    return { allowed: false, reason: 'domain_daily_cap', capToday, sentToday: args.sentToday };
  }
  return { allowed: true, capToday, sentToday: args.sentToday };
}

/** Remaining sends allowed today against the account cap (never negative). */
export function remainingToday(ageDays: number, sentToday: number): number {
  return Math.max(0, warmupCap(ageDays) - sentToday);
}
