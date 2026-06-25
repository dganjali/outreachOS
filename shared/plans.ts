// Plan catalog - the single source of truth for monetization tiers and the
// limits each tier unlocks. Imported by BOTH the server (rate limiting, Stripe
// price mapping, quota enforcement) and the React client (pricing/upgrade UI),
// so keep it dependency-free (no env, no Node, no Stripe types).
//
// Stripe price ids are NOT here - they live in server env (api/_lib/env.ts) and
// are mapped to plan ids in api/billing/stripe.ts, because they differ per
// environment (test vs live) and must never ship to the browser bundle.

export type PlanId = 'free' | 'starter' | 'pro' | 'scale';

// A subscription can be in one of these states (mirrors the Stripe statuses we
// care about). Anything not 'active'/'trialing'/'past_due' falls back to free
// limits via resolvePlan() below.
export type PlanStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';

export interface PlanLimits {
  /** Headline value metric - missions a user may launch per calendar month. */
  missionsPerMonth: number;
  /** Cost guard - agent runs (LLM + web-search calls) allowed per rolling 24h. */
  agentRunsPerDay: number;
  /**
   * Burst guard - agent runs per rolling 60s. Must stay high enough for the
   * app's own parallel mission pipeline: a 15-company run needs ~46 agent runs
   * before replacements, so low burst caps make normal runs appear stalled.
   */
  agentRunsPerMinute: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. 0 for the free tier. */
  priceMonthly: number;
  /** Short pitch shown under the plan name on the pricing card. */
  blurb: string;
  /** Bullet points for the pricing card. */
  features: string[];
  limits: PlanLimits;
  /** Whether this plan is purchasable via Stripe Checkout (false for free). */
  purchasable: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    blurb: 'Kick the tires on real outreach.',
    features: ['3 mission launches / month', 'Up to 60 agent runs / day', 'Manual follow-ups'],
    limits: { missionsPerMonth: 3, agentRunsPerDay: 60, agentRunsPerMinute: 60 },
    purchasable: false,
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 10,
    blurb: 'For trying real campaigns without the Pro commitment.',
    features: ['10 mission launches / month', 'Up to 150 agent runs / day', 'Email + reply triage'],
    limits: { missionsPerMonth: 10, agentRunsPerDay: 150, agentRunsPerMinute: 60 },
    purchasable: true,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 29,
    blurb: 'For founders and operators running outreach weekly.',
    features: [
      '30 mission launches / month',
      'Up to 400 agent runs / day',
      'Priority pipeline throughput',
      'Email + reply triage',
    ],
    limits: { missionsPerMonth: 30, agentRunsPerDay: 400, agentRunsPerMinute: 90 },
    purchasable: true,
  },
  scale: {
    id: 'scale',
    name: 'Pro Scale',
    priceMonthly: 99,
    blurb: 'High-volume outbound across many campaigns.',
    features: [
      '150 mission launches / month',
      'Up to 1,500 agent runs / day',
      'Highest burst throughput',
      'Everything in Pro',
    ],
    limits: { missionsPerMonth: 150, agentRunsPerDay: 1500, agentRunsPerMinute: 120 },
    purchasable: true,
  },
};

/** Ordered for display (free → paid). */
export const PLAN_ORDER: PlanId[] = ['free', 'starter', 'pro', 'scale'];

export const DEFAULT_PLAN: PlanId = 'free';

/**
 * ISO-4217 currency all plan prices are billed in. The Stripe Prices are
 * denominated in CAD, so the UI must say so - a bare "$" reads as USD to most
 * visitors. Keep this in sync with the currency of the Stripe Prices.
 */
export const PLAN_CURRENCY = 'CAD';

/** Monthly price with an explicit Canadian-dollar marker, e.g. "C$29". */
export function formatPriceMonthly(priceMonthly: number): string {
  return `C$${priceMonthly}`;
}

export function isPlanId(v: unknown): v is PlanId {
  return v === 'free' || v === 'starter' || v === 'pro' || v === 'scale';
}

/**
 * Resolve the *effective* plan a user should be billed-limited at, given the
 * plan they bought and the current subscription status. A canceled/incomplete
 * subscription drops the user back to free limits; past_due keeps access (Stripe
 * is still retrying payment) so we don't punish a transient card decline.
 */
export function resolvePlan(plan: PlanId | null | undefined, status: PlanStatus | null | undefined): PlanId {
  const p = isPlanId(plan) ? plan : DEFAULT_PLAN;
  if (p === 'free') return 'free';
  if (status === 'canceled' || status === 'incomplete') return 'free';
  return p; // active | trialing | past_due | (null, treated as active for legacy)
}

export function planLimits(plan: PlanId | null | undefined, status?: PlanStatus | null): PlanLimits {
  return PLANS[resolvePlan(plan, status)].limits;
}

/** True when the caller's effective plan is any paid tier (gates Campaign
 *  Autopilot and other paid-only features). */
export function isPaidPlan(plan: PlanId | null | undefined, status?: PlanStatus | null): boolean {
  return resolvePlan(plan, status) !== 'free';
}
