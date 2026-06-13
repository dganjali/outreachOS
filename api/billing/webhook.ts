// POST /api/billing/webhook — Stripe webhook. Mounted with a RAW body parser
// (see server/index.ts) because signature verification needs the exact bytes.
//
// This is the source of truth that flips a user's plan: Checkout and the portal
// only start flows; Stripe tells us the real outcome here. Authenticated by the
// Stripe-Signature header (STRIPE_WEBHOOK_SECRET), not a user JWT.

import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { adminDb, COL } from '../_lib/db';
import { env } from '../_lib/env';
import type { ProfileDoc } from '../../shared/schemas';
import type { PlanId, PlanStatus } from '../../shared/plans';
import { getStripe, planForPriceId, BillingNotConfiguredError } from './stripe';

export default async function handler(req: Request, res: Response) {
  const secret = env.STRIPE_WEBHOOK_SECRET();
  if (!secret) return res.status(503).json({ error: 'billing_not_configured' });

  let stripe: Stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) return res.status(503).json({ error: 'billing_not_configured' });
    throw err;
  }

  const sig = req.headers['stripe-signature'];
  let event: Stripe.Event;
  try {
    // req.body is a Buffer here (express.raw). constructEvent verifies the HMAC.
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig as string, secret);
  } catch (err) {
    console.error('[billing] webhook signature verification failed', (err as Error).message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId ?? null;
        const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null;
        // Ensure the customer id is mapped onto the profile (it normally is from
        // checkout.ts, but this is a belt-and-suspenders for customers created
        // out-of-band). Plan flip happens on the subscription event below.
        if (userId && customerId) {
          await updateBillingByUserId(userId, { stripeCustomerId: customerId });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        await applySubscription(sub);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = customerIdOf(sub);
        if (customerId) {
          await updateBillingByCustomerId(customerId, {
            plan: 'free',
            planStatus: 'canceled',
            stripeSubscriptionId: null,
            planRenewsAt: null,
          });
        }
        break;
      }

      default:
        // Ignore everything else; Stripe sends many event types.
        break;
    }
  } catch (err) {
    console.error('[billing] webhook handler error', event.type, (err as Error).message);
    // 500 so Stripe retries — the event is valid, our processing failed.
    return res.status(500).json({ error: 'handler_error' });
  }

  return res.json({ received: true });
}

// --- helpers ---------------------------------------------------------------

type BillingFields = Partial<
  Pick<ProfileDoc, 'plan' | 'planStatus' | 'stripeCustomerId' | 'stripeSubscriptionId' | 'planRenewsAt'>
>;

function customerIdOf(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
}

/** Map a Stripe subscription status onto our narrower PlanStatus. */
function toPlanStatus(s: Stripe.Subscription.Status): PlanStatus {
  switch (s) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

/** Flip a profile's plan from a subscription's current price + status. */
async function applySubscription(sub: Stripe.Subscription) {
  const customerId = customerIdOf(sub);
  if (!customerId) return;

  const priceId = sub.items.data[0]?.price?.id;
  const plan: PlanId = planForPriceId(priceId) ?? (sub.metadata?.plan as PlanId) ?? 'free';
  const status = toPlanStatus(sub.status);
  const renewsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;

  await updateBillingByCustomerId(customerId, {
    plan,
    planStatus: status,
    stripeSubscriptionId: sub.id,
    planRenewsAt: renewsAt,
  });
}

async function updateBillingByCustomerId(customerId: string, fields: BillingFields) {
  const db = await adminDb();
  await db
    .collection<ProfileDoc>(COL.profiles)
    .updateOne({ stripeCustomerId: customerId }, { $set: { ...fields, planUpdatedAt: new Date(), updatedAt: new Date() } });
}

async function updateBillingByUserId(userId: string, fields: BillingFields) {
  const db = await adminDb();
  await db
    .collection<ProfileDoc>(COL.profiles)
    .updateOne({ userId }, { $set: { ...fields, planUpdatedAt: new Date(), updatedAt: new Date() } });
}
