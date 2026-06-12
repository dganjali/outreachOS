// POST /api/billing/portal — open the Stripe customer billing portal so the
// user can update their card, switch plans, or cancel. Returns { url }.

import type { Request, Response } from 'express';
import { requireUser } from '../_lib/auth';
import { forUser } from '../_lib/db';
import { env } from '../_lib/env';
import type { ProfileDoc } from '../../shared/schemas';
import { getStripe, BillingNotConfiguredError } from './stripe';

export default async function handler(req: Request, res: Response) {
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const profile = await forUser(user.id).collection<ProfileDoc>('profiles').findOne({});
    const customerId = profile?.stripeCustomerId;
    if (!customerId) return res.status(400).json({ error: 'no_customer', detail: 'No billing account yet.' });

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${env.APP_URL()}/settings`,
    });
    return res.json({ url: session.url });
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      return res.status(503).json({ error: 'billing_not_configured' });
    }
    throw err;
  }
}
