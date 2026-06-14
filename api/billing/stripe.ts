// Stripe plumbing shared by the billing endpoints: a lazily-initialized client,
// the plan <-> Stripe-Price-id mapping (kept server-side, never shipped to the
// browser), and a service-role helper to find a profile by Stripe customer id
// (needed in the webhook, which is authenticated by Stripe signature, not a JWT).

import Stripe from 'stripe';
import { env } from '../_lib/env';
import { adminDb, COL } from '../_lib/db';
import type { ProfileDoc } from '../../shared/schemas';
import type { PlanId } from '../../shared/plans';

let _stripe: Stripe | null = null;

/** Throws a clear error (caught by callers → 503) if Stripe isn't configured. */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = env.STRIPE_SECRET_KEY();
  if (!key) throw new BillingNotConfiguredError();
  _stripe = new Stripe(key, { apiVersion: '2025-02-24.acacia' });
  return _stripe;
}

export class BillingNotConfiguredError extends Error {
  constructor() {
    super('billing_not_configured');
    this.name = 'BillingNotConfiguredError';
  }
}

/** Map a paid plan id to its configured Stripe Price id. Null if not a paid plan. */
export function priceIdForPlan(plan: PlanId): string | null {
  switch (plan) {
    case 'starter':
      return env.STRIPE_PRICE_STARTER() || null;
    case 'pro':
      return env.STRIPE_PRICE_PRO() || null;
    case 'scale':
      return env.STRIPE_PRICE_SCALE() || null;
    default:
      return null;
  }
}

/** Reverse map: which plan does a Stripe Price id correspond to? */
export function planForPriceId(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_STARTER()) return 'starter';
  if (priceId === env.STRIPE_PRICE_PRO()) return 'pro';
  if (priceId === env.STRIPE_PRICE_SCALE()) return 'scale';
  return null;
}

/**
 * Service-role lookup of a profile by its Stripe customer id. Used by the
 * webhook, which has no user JWT - so it bypasses forUser() and queries the
 * collection directly (the customer id is the trust anchor).
 */
export async function profileByCustomerId(customerId: string): Promise<ProfileDoc | null> {
  const db = await adminDb();
  return db.collection<ProfileDoc>(COL.profiles).findOne({ stripeCustomerId: customerId });
}
