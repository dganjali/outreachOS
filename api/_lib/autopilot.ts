// Campaign Autopilot - pure policy logic (the confidence gate + send-slot
// scheduling + daily-counter rollover). Kept side-effect-free so it's unit
// testable; the cron (api/cron/autopilot-tick.ts) supplies the I/O.

import type { CampaignPolicyDoc, ContactDoc } from '../../shared/schemas';

// Defaults applied when a policy is created or a field is missing. Conservative:
// small daily cap, business-hours window, opt-in auto-send.
export const POLICY_DEFAULTS = {
  autoSend: false,
  targetsPerCycle: 5,
  cycleIntervalHours: 24,
  dailySendCap: 10,
  sendWindow: { startHour: 9, endHour: 17 },
  timezone: 'America/Toronto',
  minConfidence: 0.6,
} as const;

// Hard ceilings so a hand-edited policy can't blow past sane limits / plan caps.
export const MAX_TARGETS_PER_CYCLE = 25;
export const MAX_DAILY_SEND_CAP = 100;

export type GateVerdict = 'auto' | 'review';

/**
 * The confidence gate. A draft auto-sends only when the recipient address is
 * *verified* (deliverability floor) AND the contact clears the confidence
 * threshold. Everything else is held for a human.
 */
export function gateDecision(contact: Pick<ContactDoc, 'emailStatus' | 'confidence'>, policy: Pick<CampaignPolicyDoc, 'minConfidence'>): GateVerdict {
  if (contact.emailStatus !== 'verified') return 'review';
  if ((contact.confidence ?? 0) < policy.minConfidence) return 'review';
  return 'auto';
}

/** UTC 'YYYY-MM-DD' for the daily counter key. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Today's auto-send count, rolling the counter over when the UTC day changes. */
export function sentToday(policy: Pick<CampaignPolicyDoc, 'counter'>, now: Date): number {
  const day = utcDay(now);
  if (!policy.counter || policy.counter.date !== day) return 0;
  return policy.counter.sent;
}

/** How many more auto-sends the cap allows right now (never negative). */
export function remainingCapToday(policy: Pick<CampaignPolicyDoc, 'counter' | 'dailySendCap'>, now: Date): number {
  return Math.max(0, policy.dailySendCap - sentToday(policy, now));
}

/** A counter value reflecting `add` more sends today (rolls over on day change). */
export function bumpedCounter(policy: Pick<CampaignPolicyDoc, 'counter'>, now: Date, add: number): { date: string; sent: number } {
  return { date: utcDay(now), sent: sentToday(policy, now) + add };
}

// --- Send-window scheduling ------------------------------------------------
//
// We compute slots in the policy's IANA timezone without pulling a tz library:
// derive the zone's current UTC offset via Intl, then reason in "local" ms.

/** Minutes east of UTC for `tz` at instant `now` (e.g. -240 for EDT). */
export function tzOffsetMinutes(tz: string, now: Date): number {
  try {
    // Format the instant in the target zone, parse it back as if UTC, and the
    // difference from the real instant is the offset.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - now.getTime()) / 60000);
  } catch {
    return 0; // unknown tz ⇒ treat the window as UTC
  }
}

/**
 * Up to `count` send timestamps, evenly spread inside the next open send window
 * (in the policy timezone), drip-style. If `now` is already inside today's
 * window, the first slot is `now`; otherwise slots start at the next window open
 * (later today, or tomorrow if the window has passed). Returns [] for count<=0.
 */
export function nextSendSlots(
  policy: Pick<CampaignPolicyDoc, 'sendWindow' | 'timezone'>,
  count: number,
  now: Date,
): Date[] {
  if (count <= 0) return [];
  const { startHour, endHour } = policy.sendWindow;
  // Degenerate/empty window ⇒ just drip from now, a few minutes apart.
  if (!(endHour > startHour)) {
    return Array.from({ length: count }, (_, i) => new Date(now.getTime() + i * 5 * 60000));
  }

  const offsetMin = tzOffsetMinutes(policy.timezone, now);
  // "Local now" = the wall-clock instant in the zone, expressed as a UTC ms value
  // we can do hour math on. Convert back by subtracting the offset.
  const localNowMs = now.getTime() + offsetMin * 60000;
  const localNow = new Date(localNowMs);
  const localMidnight = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate());
  const windowStartMs = localMidnight + startHour * 3600000;
  const windowEndMs = localMidnight + endHour * 3600000;

  let startLocalMs: number;
  let endLocalMs: number;
  if (localNowMs < windowStartMs) {
    startLocalMs = windowStartMs; // window opens later today
    endLocalMs = windowEndMs;
  } else if (localNowMs >= windowEndMs) {
    startLocalMs = windowStartMs + 86400000; // window passed ⇒ tomorrow
    endLocalMs = windowEndMs + 86400000;
  } else {
    startLocalMs = localNowMs; // mid-window ⇒ start now
    endLocalMs = windowEndMs;
  }

  const spanMs = Math.max(0, endLocalMs - startLocalMs);
  // Spread across the available span; cap spacing so a big batch still fits.
  const step = count > 1 ? spanMs / count : 0;
  const toUtc = (localMs: number) => new Date(localMs - offsetMin * 60000);
  return Array.from({ length: count }, (_, i) => toUtc(startLocalMs + Math.round(i * step)));
}

/**
 * Clamp `date`'s time-of-day into the send window while keeping its calendar day
 * (in the policy timezone). Used for follow-ups: their multi-day cadence must
 * stay put, but the hour they land on should honor the window. A time already
 * inside the window is returned unchanged; one before/after is pulled to the
 * window's open on the same local day. Degenerate windows pass through.
 */
export function snapToWindow(date: Date, policy: Pick<CampaignPolicyDoc, 'sendWindow' | 'timezone'>): Date {
  const { startHour, endHour } = policy.sendWindow;
  if (!(endHour > startHour)) return date;

  const offsetMin = tzOffsetMinutes(policy.timezone, date);
  const localMs = date.getTime() + offsetMin * 60000;
  const local = new Date(localMs);
  const localMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const windowStartMs = localMidnight + startHour * 3600000;
  const windowEndMs = localMidnight + endHour * 3600000;

  // Inside the window already ⇒ keep. Otherwise snap to the window open, same day.
  const snappedLocalMs = localMs >= windowStartMs && localMs < windowEndMs ? localMs : windowStartMs;
  return new Date(snappedLocalMs - offsetMin * 60000);
}

/** A queued send row, reduced to the fields rescheduling needs. */
export interface QueuedSendLite {
  id: string;
  touchIndex: number;
  scheduledSendAt: Date | string | null;
}

/**
 * Pure planner for a send-window/timezone change: recompute `scheduledSendAt`
 * for the still-queued sends so they fall inside the new window.
 *   - Initial touches (touchIndex 0) are redistributed across the next open
 *     window via nextSendSlots - the same logic that first scheduled them -
 *     ordered by their current send time so the queue order is preserved.
 *   - Follow-ups (touchIndex > 0) keep their calendar day (the cadence) and only
 *     have their time-of-day snapped into the window.
 * Returns only the rows whose time actually moved.
 */
export function planReschedule(
  rows: QueuedSendLite[],
  policy: Pick<CampaignPolicyDoc, 'sendWindow' | 'timezone'>,
  now: Date,
): Array<{ id: string; scheduledSendAt: Date }> {
  const ms = (v: Date | string | null): number => (v ? new Date(v).getTime() : 0);
  const out: Array<{ id: string; scheduledSendAt: Date }> = [];

  const initial = rows.filter((r) => r.touchIndex === 0).sort((a, b) => ms(a.scheduledSendAt) - ms(b.scheduledSendAt));
  const slots = nextSendSlots(policy, initial.length, now);
  initial.forEach((r, i) => {
    if (slots[i] && slots[i].getTime() !== ms(r.scheduledSendAt)) out.push({ id: r.id, scheduledSendAt: slots[i] });
  });

  for (const r of rows) {
    if (r.touchIndex === 0 || !r.scheduledSendAt) continue;
    const snapped = snapToWindow(new Date(r.scheduledSendAt), policy);
    if (snapped.getTime() !== ms(r.scheduledSendAt)) out.push({ id: r.id, scheduledSendAt: snapped });
  }
  return out;
}

/** Fill a partial/legacy policy with defaults so callers can read every field. */
export function withPolicyDefaults(p: Partial<CampaignPolicyDoc>): Omit<CampaignPolicyDoc, keyof import('../../shared/schemas').BaseDoc | 'missionId'> {
  return {
    enabled: p.enabled ?? false,
    autoSend: p.autoSend ?? POLICY_DEFAULTS.autoSend,
    targetsPerCycle: clamp(p.targetsPerCycle ?? POLICY_DEFAULTS.targetsPerCycle, 1, MAX_TARGETS_PER_CYCLE),
    cycleIntervalHours: clamp(p.cycleIntervalHours ?? POLICY_DEFAULTS.cycleIntervalHours, 1, 24 * 14),
    lastSourcedAt: p.lastSourcedAt ?? null,
    dailySendCap: clamp(p.dailySendCap ?? POLICY_DEFAULTS.dailySendCap, 1, MAX_DAILY_SEND_CAP),
    sendWindow: p.sendWindow ?? { ...POLICY_DEFAULTS.sendWindow },
    timezone: p.timezone ?? POLICY_DEFAULTS.timezone,
    minConfidence: clamp(p.minConfidence ?? POLICY_DEFAULTS.minConfidence, 0, 1),
    counter: p.counter ?? null,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Whether the sourcing cadence allows a new run now. */
export function sourcingDue(policy: Pick<CampaignPolicyDoc, 'lastSourcedAt' | 'cycleIntervalHours'>, now: Date): boolean {
  if (!policy.lastSourcedAt) return true;
  const elapsedH = (now.getTime() - new Date(policy.lastSourcedAt).getTime()) / 3600000;
  return elapsedH >= policy.cycleIntervalHours;
}
