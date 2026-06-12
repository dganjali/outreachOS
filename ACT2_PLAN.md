# ACT2_PLAN.md — the compounding moat

register: strategy

Act 1 made OutreachOS **autonomous** (durable pipeline → policy-driven
autopilot). Act 2 makes it **compound and trustworthy**: it learns what gets
*this user* replies, and it earns the right to send on their domain. These are
the two things a wrapper-around-an-LLM competitor cannot copy — one is built on
the user's private outcome data, the other is unglamorous infrastructure most
tools skip.

Two pillars:

- **A. The learning flywheel** — month-6 is dramatically better than month-1.
- **B. Deliverability & sender reputation** — volume sending that doesn't burn
  the user's domain.

Both plug directly into the **Act 1.2 confidence gate** (`api/_lib/autopilot.ts`
`evaluateGate`): every signal Act 2 produces becomes a new gate input, so the
autopilot gets smarter and safer without new control surfaces.

---

## What we already capture (the raw material)

Act 2 is mostly *reading* data the app already writes — not new instrumentation:

| Signal | Where | Used for |
|---|---|---|
| Every send (subject, body, touch, time, recipient) | `sent_messages` | win/loss features |
| Every reply + classification | `replies` (classification, urgency) | the outcome label |
| Sequence text embeddings | `email_sequences.embedding` + `sequence_vector_idx` | voice exemplars |
| Evidence embeddings per target | `evidence_packs.embedding` + `evidence_vector_idx` | propensity |
| Contact quality | `contacts.confidence`, `emailStatus` | already a gate input |
| Agent telemetry | `agent_runs` | cost/quality attribution |

The gap is a **read model** that joins these into outcomes, plus three consumers.

---

## Pillar A — The learning flywheel

### A1. Outcome read-model (`api/_lib/outcomes.ts`) — foundation
Join `sent_messages` → `replies` (via `sentMessageId`/`gmailThreadId`) →
`contacts`/`targets` into a per-send **outcome record**: did the initial touch
get a positive reply, within how long, after how many touches. Persist a rolled
`mission_outcomes` / `user_outcomes` read model (cheap to recompute; recompute on
the reply poller and on a daily cron). This is the labeled dataset everything
else reads.
- **Hooks:** the reply path already halts cadence and marks contacts replied
  (`cron/poll-gmail.ts`, `agents/reply.ts`) — extend it to stamp the outcome.
- **DoD:** given a mission, return `{ sent, replied, replyRate, byOpener, bySendHour, byEvidenceType }`.

### A2. Win/loss analytics — the visible payoff
Feature-extract each sent message (opener style, length bucket, # evidence
bullets anchored, send hour/day, touch index) and correlate with the A1 label.
Surface the top correlations per user: *"your 2-sentence openers reply at 3× your
long ones," "Tue 14:00–16:00 UTC outperforms."*
- **Surface:** a panel on the dashboard / mission page (reuse the existing
  `.stat-strip` pattern). Read-only, no model — just honest aggregates with
  enough-sample guards.
- **DoD:** a `GET /api/analytics/winloss?mission_id=` returning ranked,
  sample-gated insights.

### A3. Per-user voice model — sharpen the drafts
The sequence agent already retrieves exemplars by vector similarity
(`agents/sequence.ts` `fetchReplyExemplars`, `sequence_vector_idx`). Today it
filters loosely; **weight retrieval toward sequences that actually got a positive
reply** (join through A1), and inject the top exemplars as style anchors. Over
time the draft model converges on what works for *this* sender.
- **Hooks:** `fetchReplyExemplars` + `prompts.ts` (exemplar block).
- **DoD:** exemplars passed to the LLM are restricted to replied-positive
  sequences when ≥N exist; measured against A2 reply rate.

### A4. Target propensity scoring — margin *and* quality at once
Before spending ~$0.085 researching a target (`MONETIZATION.md`), score its
likely reply rate: embed the candidate (company + signal) and compare to the
`evidence_packs` embeddings of past **replied** targets (cosine via
`evidence_vector_idx`, filtered by `userId`). High-propensity targets get
researched first; low ones are deprioritized or skipped.
- **Hooks:** the Act 1.1 pipeline (`api/_lib/pipeline.ts` targeting → rank) and
  the Act 1.2 gate (propensity becomes a new `GateInput`).
- **Payoff:** research budget flows to likely converters → better reply rate and
  lower cost per reply simultaneously. This is the clearest margin lever in the
  product.
- **DoD:** targeting output carries a `propensity` score; the autopilot gate can
  require a minimum.

**Cold-start:** all four degrade gracefully — with no history, A2/A3/A4 fall back
to today's behavior (global heuristics, unweighted exemplars, score = neutral).
No regression for new users.

---

## Pillar B — Deliverability & sender reputation

Volume sending without this churns users in week 2. Each piece is a new gate
input, so the autopilot won't send when reputation is at risk.

### B1. Domain auth check at connect time
On Gmail connect (`integrations/gmail/callback.ts`), resolve and evaluate the
sender domain's SPF/DKIM/DMARC (DNS TXT lookups — reuse the SSRF-safe DNS posture
from `web-scrape.ts`). Show a clear status in Settings; warn before autopilot
sends from an unauthenticated domain.
- **DoD:** `user_integrations` carries `domainAuth: { spf, dkim, dmarc }`;
  surfaced in `integrations/gmail/status.ts`.

### B2. Bounce & complaint handling → suppression
Auto-suppress addresses that hard-bounce or complain. The suppression machinery
exists (`sequencing.ts` `addSuppression`, `suppressions` collection); wire bounce
detection into it. *Note:* reading bounce notifications needs Gmail read scope —
currently `poll-gmail.ts` is disabled to stay in the "sensitive" tier
(`gmail.ts` GMAIL_SCOPES comment). **Decision required:** complete restricted-scope
review, or parse mailer-daemon bounces via a lighter signal. Track as the one
real external dependency in this pillar.
- **DoD:** a bounced/complained address lands in `suppressions` and is never
  re-sent (the send path already checks `isSuppressed`).

### B3. Reputation-aware send caps + warmup
Generalize the Act 1.2 `maxSendsPerDay` flat cap into a **per-domain ramp**: new
senders start low and increase as positive signal accrues; throttle on a
bounce/complaint spike. The autopilot already counts daily sends from
`sent_messages` — make the cap a function of sender age + recent bounce rate
instead of a constant.
- **Hooks:** `api/_lib/autopilot.ts` `maybeSend` budget calc.
- **DoD:** the daily budget is computed from a warmup schedule, not the static
  policy number.

### B4. Pre-send spam-content lint
Lint drafts for spam triggers (link count, ALL-CAPS, spammy phrases, image-only,
broken merge tags) before they queue. A failed lint holds the draft for review.
- **Hooks:** `agents/sequence.ts` (write-time) + the autopilot gate (send-time).
- **DoD:** a `lintDraft(subject, body)` returning issues; high-severity issues
  block auto-send.

---

## How Act 2 feeds Act 1.2 (the unifying idea)

`evaluateGate` gains inputs — and the autopilot quietly gets smarter and safer:

```
evaluateGate(policy, {
  contactConfidence, emailStatus, hasEmail, hasEvidence,  // today
  propensity,            // A4 — skip low-likelihood sends
  domainAuthenticated,   // B1 — don't send from an unauthed domain
  spamLintSeverity,      // B4 — hold spammy drafts
})
```

No new screens; the policy the user already approved just enforces more.

---

## Monetization tie-in

- **A4 propensity** is the margin story: research spend flows to converters, so
  cost-per-reply drops — defend or improve the `MONETIZATION.md` tiers.
- **A1/A2 outcomes** unlock **outcome-aligned pricing** (a premium tied to
  *replies handled* / *meetings*), which is only credible once we measure
  outcomes — exactly what A1 builds.

---

## Recommended sequence

1. **A1 outcome read-model** — foundation; everything else reads it.
2. **A4 propensity scoring** — fastest ROI (margin + quality), plugs into the
   gate immediately.
3. **B1 + B4** (domain auth + spam lint) — cheap, high-trust, no scope blockers.
4. **A2 win/loss panel** — the visible "it's learning" moment.
5. **A3 voice weighting** — compounding quality once there's reply history.
6. **B2 + B3** (bounce handling + warmup) — gated on the Gmail read-scope
   decision; do last.

## Risks / open decisions
- **Gmail read scope (B2):** restricted-scope review vs. lighter bounce parsing —
  the one real external dependency. Decide before promising bounce auto-suppression.
- **Sample size:** A2/A3/A4 must gate on minimum history and fall back cleanly —
  never show a "trend" off three sends.
- **Vector index cost:** propensity (A4) leans on Atlas vector search (M10+);
  already required per `TODO.md`, so no new infra, but budget the queries.
