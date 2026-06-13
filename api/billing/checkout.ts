// POST /api/billing/checkout — start a Stripe Checkout session to subscribe to
// a paid plan. Body: { plan: 'pro' | 'scale' }. Returns { url } to redirect to.

import type { Request, Response } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { env } from '../_lib/env';
import type { ProfileDoc } from '../../shared/schemas';
import { isPlanId, PLANS } from '../../shared/plans';
import { getStripe, priceIdForPlan, BillingNotConfiguredError } from './stripe';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;

  const plan = (req.body ?? {}).plan;
  if (!isPlanId(plan) || !PLANS[plan].purchasable) {
    return res.status(400).json({ error: 'invalid_plan' });
  }

  const priceId = priceIdForPlan(plan);
  if (!priceId) return res.status(503).json({ error: 'plan_not_configured', detail: `No Stripe price for ${plan}.` });

  try {
    const stripe = getStripe();
    const scope = forUser(user.id);
    const profiles = scope.collection<ProfileDoc>('profiles');
    const profile = await profiles.findOne({});

    // Reuse an existing Stripe customer, or create one keyed to this uid so the
    // webhook can map events back to the user.
    let customerId = profile?.stripeCustomerId ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;
      if (profile) await profiles.updateById(profile._id, { stripeCustomerId: customerId });
    }

    const appUrl = env.APP_URL();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Carried into checkout.session.completed and onto the subscription so the
      // webhook knows which plan/user without re-deriving from the price id.
      metadata: { userId: user.id, plan },
      subscription_data: { metadata: { userId: user.id, plan } },
      allow_promotion_codes: true,
      success_url: `${appUrl}/settings?billing=success`,
      cancel_url: `${appUrl}/settings?billing=cancelled`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      return res.status(503).json({ error: 'billing_not_configured' });
    }
    throw err;
  }
}
