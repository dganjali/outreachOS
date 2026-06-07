# MONETIZATION.md — pricing, usage limits, and Stripe

Plan for charging for OutreachOS: the unit cost model (post Gemini/Vertex swap),
usage limits and where to enforce them, subscription tiers, and the Stripe
implementation. No code is written yet; this is the blueprint. File and constant
references point at where enforcement lands.

---

## 1. Unit cost model

### Verified pricing (Google, June 2026)
| Item | Price |
|---|---|
| Gemini 2.5 Flash input | $0.30 / 1M tokens |
| Gemini 2.5 Flash output | $2.50 / 1M tokens (thinking disabled in our adapter) |
| Grounding with Google Search | **1,500 grounded prompts/day free (project-wide)**, then **$35 / 1,000 = $0.035 each** |
| gemini-embedding-001 | $0.15 / 1M tokens (negligible here) |

**Key insight: grounding dominates.** Token cost per agent call is ~$0.005–0.01;
each grounded call adds a flat $0.035. So cost is driven by *how many agent steps
hit Google Search*, not by tokens.

### Cost per agent call (full cost, i.e. past the daily free grounding)
| Agent | Grounded? | ~Input | ~Output | Token $ | Ground $ | Total |
|---|---|---|---|---|---|---|
| Targeting (`target.ts`) | yes | 8K | 3K | $0.010 | $0.035 | **~$0.045** |
| Evidence (`evidence.ts`) | yes | 6K | 1.5K | $0.006 | $0.035 | **~$0.041** |
| Contacts (`contacts.ts`) | yes | 6K | 1K | $0.004 | $0.035 | **~$0.039** |
| Sequence (`sequence.ts`) | no | 4K | 1.5K | $0.005 | — | **~$0.005** |
| Embedding | no | 0.5K | — | ~$0.0001 | — | ~$0 |
| Reply classify (`reply.ts`) | no | 2K | 0.5K | ~$0.002 | — | ~$0.002 |

### Per target and per pipeline
A fully processed target = evidence + contacts + sequence (+ embeds):

- **~$0.085 per target (full cost)**
- A pipeline run = 1 targeting call + `TOP_N` targets. At `TOP_N=5`:
  **1 × $0.045 + 5 × $0.085 ≈ $0.47 per pipeline run (full cost).**

### Two cost regimes (because of free grounding)
The 1,500 free grounded prompts/day are **shared across all users**. A pipeline
uses ~11 grounded calls (targeting + evidence×5 + contacts×5), so ~136 full
pipelines/day are grounded for free before any grounding charge.

| Regime | Per target | Per pipeline | When |
|---|---|---|---|
| Free-grounding (early) | **~$0.015** | **~$0.085** | < 1,500 grounded calls/day globally |
| Full cost (at scale) | **~$0.09** | **~$0.47** | beyond the free tier |

**All tier margins below use the conservative full-cost numbers.** The free
grounding tier is upside, especially in the first months.

> Note: Apollo (optional, user supplies `APOLLO_API_KEY`) is billed to the user,
> not to us. It is not in this model.

---

## 2. Usage limits — the levers

Five things we can meter or cap. The first two are the real cost levers.

| Lever | Where it lives today | How to make it plan-driven |
|---|---|---|
| **Targets processed / billing period** | n/a (new counter) | primary quota; increment per processed target, compare to plan cap |
| **Targets per run** (`TOP_N`, `TARGET_COUNT`) | `pipeline.ts:20-21` | read from plan instead of constants |
| **Contacts surfaced per target** | `contacts.ts` (returns all) | add `CONTACTS_PER_TARGET` plan field, slice results |
| **Pipelines / missions per period** | n/a | organizational cap; cheap to enforce |
| **Daily safety cap** (abuse guard) | `runs.ts:8 RATE_PER_DAY=50`, `:7 RATE_PER_MINUTE=5` | keep as anti-abuse; scale per plan |

The cleanest customer-facing unit is **targets processed per month** (it tracks
cost almost linearly). "Pipeline runs" is the friendlier label; internally we
meter targets.

---

## 3. Tiers

Prices in USD/month. Cost and margin at **full cost** (~$0.09/target); real early
margin is higher thanks to free grounding.

| Plan | Price | Active missions | Targets / mo | Targets / run | Contacts / target | Seats | Est. cost | Margin |
|---|---|---|---|---|---|---|---|---|
| **Free** | $0 | 1 | 15 (one-time) | 5 | 2 | 1 | ≤ $1.40 | CAC |
| **Starter** | $19 | 5 | 60 (~12 runs) | 5 | 3 | 1 | ~$5.40 | **~72%** |
| **Pro** | $49 | Unlimited | 200 (~40 runs) | 8 | 5 | 1 | ~$18 | **~63%** |
| **Scale** | $149 | Unlimited | 750 (~94 runs) | 10 | 8 | 3 | ~$67 | **~55%** |

**Free** is an activation funnel: enough to land one real reply (its north-star),
then it locks with an upgrade prompt. Worst-case cost per free signup ≤ $1.40,
and near-zero while under the free grounding tier.

### Overage (Pro and Scale only)
When the monthly target quota is hit, offer a one-click top-up instead of a hard
stop:

- **Target pack: 100 targets for $15** ($0.15/target → ~40% margin at full cost,
  much more under free grounding).
- Or metered overage at **$0.15 / target** via a Stripe metered price.

Starter hits a hard cap with an upgrade CTA (keeps the entry tier predictable).

### Why these numbers
- Cost is so low (~$0.09/target worst case) that pricing is **value-based**, not
  cost-plus. Competing tools (Apollo, Outreach, Lemlist) sit at $30–100+/seat;
  $19/$49 undercuts while keeping 60–72% margins even at full cost.
- The cost driver the customer feels is "how many companies did the agent work,"
  which is exactly the target quota. Easy to explain, easy to meter.

---

## 4. Data model

Add billing state to the user. Either new fields on `profiles` or a dedicated
`subscriptions` collection (preferred; keep billing separate from profile).

```
subscriptions (one per user, _id = userId)
  plan:               'free' | 'starter' | 'pro' | 'scale'
  status:             'active' | 'past_due' | 'canceled' | 'trialing'
  stripeCustomerId:   string
  stripeSubscriptionId: string | null
  currentPeriodStart: ISO
  currentPeriodEnd:   ISO
  usage: {
    targetsThisPeriod:   number   // reset on invoice.paid / period rollover
    pipelinesThisPeriod: number
  }
  topUps: { targetsRemaining: number }   // from target packs
```

Plan limits live in code as a constant map (single source of truth), not in the DB:

```
const PLAN_LIMITS = {
  free:    { missions: 1,   targetsPerMonth: 15,  targetsPerRun: 5,  contactsPerTarget: 2, seats: 1 },
  starter: { missions: 5,   targetsPerMonth: 60,  targetsPerRun: 5,  contactsPerTarget: 3, seats: 1 },
  pro:     { missions: Infinity, targetsPerMonth: 200, targetsPerRun: 8,  contactsPerTarget: 5, seats: 1 },
  scale:   { missions: Infinity, targetsPerMonth: 750, targetsPerRun: 10, contactsPerTarget: 8, seats: 3 },
};
```

---

## 5. Enforcement points (in existing code)

1. **`api/_lib/runs.ts` → extend `checkRateLimit`** into `checkQuota(scope, { needTargets })`:
   - keep the 5/min + N/day abuse guard,
   - load the user's plan + `usage.targetsThisPeriod`,
   - if `targetsThisPeriod + needTargets > targetsPerMonth` and no top-up credit:
     return `402 { error: 'quota_exceeded', plan, upgradeTo }`.
2. **`api/agents/pipeline.ts`** — replace the `TOP_N` / `TARGET_COUNT` constants
   with `min(planTargetsPerRun, remainingQuota)`; increment
   `usage.targetsThisPeriod` per target actually processed.
3. **`api/agents/target.ts`** — clamp `desired` (line 47) to the plan's per-run cap.
4. **`api/agents/contacts.ts`** — slice returned contacts to `contactsPerTarget`.
5. **`MissionNew` / mission create** — block past `missions` cap (Free/Starter).
6. **Frontend** — surface a usage meter (extend the dashboard `.stat-strip`,
   reuse the existing "runs today" pattern) and gate run buttons with an upgrade
   modal when `402` comes back.

The agents already return `429` on rate limit and the pipeline already emits a
`paused` event for it (`pipeline.ts:84-87`), so the UI plumbing for "you hit a
limit" exists; quota just adds a `402` path that says "upgrade" instead of "wait."

---

## 6. Stripe implementation

### Products / Prices (create in Stripe dashboard or via API)
- `price_starter_monthly`, `price_pro_monthly`, `price_scale_monthly` — recurring.
- `price_target_pack` — one-time ($15) or a metered price for overage.
- Free has no Stripe object.

### Secrets (Secret Manager → Cloud Run env)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the `STRIPE_PRICE_*` ids.

### Endpoints (mount in `server/index.ts` like the other handlers)
- `POST /api/billing/checkout` — auth required; create a Checkout Session
  (`mode: 'subscription'`, the chosen price, `client_reference_id = userId`,
  success/cancel URLs); return the URL; frontend redirects.
- `POST /api/billing/portal` — create a Billing Portal session so users manage or
  cancel; return URL.
- `POST /api/billing/webhook` — **raw body** (not `express.json`) so the Stripe
  signature verifies. Handle:
  - `checkout.session.completed` → set plan + `stripeCustomerId/SubscriptionId`,
    status active, period dates.
  - `customer.subscription.updated` / `deleted` → update plan/status; on cancel,
    drop to `free` at period end.
  - `invoice.paid` → reset `usage.*` for the new period.
  - `invoice.payment_failed` → status `past_due` (soft-limit, keep read access).

> Important: the webhook needs the raw request body. Mount it **before**
> `app.use(express.json(...))` in `server/index.ts`, or use
> `express.raw({ type: 'application/json' })` on just that route.

### Frontend
- A `/pricing` route (public, brand register) + upgrade CTAs from the quota modal.
- "Manage billing" button in `SettingsPage` → `/api/billing/portal`.
- Usage meter on the dashboard.

### The boundary that matters
This app must never collect card details itself. All payment entry happens on
**Stripe-hosted Checkout and the Billing Portal**; we only ever hold customer and
subscription ids. That also keeps PCI scope minimal.

---

## 7. Rollout

1. **Meter first, charge later.** Ship the `subscriptions` doc + usage counters +
   `checkQuota` with everyone defaulted to a generous "beta" plan. Watch real
   targets/user/month for two weeks. This validates the cost model on live data
   before any price is public.
2. **Turn on Stripe** with Free + Pro only (skip Starter/Scale until there's
   signal). Hosted Checkout + Portal + webhook.
3. **Add Starter / Scale / overage** once usage distribution is known; set the
   exact target caps from observed p50/p90 usage rather than these estimates.
4. **Keep the daily safety cap** (`RATE_PER_DAY`) regardless of plan as an
   anti-abuse and cost-blowout guard.

## 8. Open decisions
- Annual pricing (typically 2 months free) — defer to step 2.
- Whether Free requires a connected Gmail before running (reduces tire-kicker
  cost; recommend yes).
- Team seats: Scale lists 3, but seat/workspace model isn't built yet; treat as
  a fast-follow, not launch.
