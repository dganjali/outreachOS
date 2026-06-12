# VISION.md — from tool to autonomous SDR

register: strategy

The arc that takes OutreachOS from "an AI that drafts emails" to **an autonomous
SDR people pay real money for.** This is the north star; `TODO.md` is the
get-it-live checklist, `MONETIZATION.md` is the pricing blueprint. This file is
the *why* and the *what next*.

---

## The core thesis

Today OutreachOS is a **copilot**: a human drives every step, and the full
pipeline runs ~16 agent calls *in the browser* — it dies if the tab closes. That
is a demo, not automation. Nobody pays $49/mo to babysit a tab.

People pay for **outcomes delivered while they sleep, that get better every
week, that they can trust to run on their own domain.** Everything below ladders
up to that one sentence.

---

## Act 1 — Make it actually autonomous (the credibility floor)

You cannot be impressive on a foundation that evaporates when a tab closes. This
act is the highest-leverage work in the repo and is **in progress**.

1. **Durable, server-run pipeline.** Move orchestration out of the browser into
   a resumable server job that survives disconnects and streams/polls progress.
   The run is a first-class, persisted record (`pipeline_runs`) — the source of
   truth — driven by a step machine that can resume from where it stopped.
   *(This is the keystone everything else stands on.)*
2. **Campaign Autopilot.** Flip the unit of control from *per-email approval* to
   *per-policy approval*: "find 10 new targets/week matching this ICP, research,
   draft, and send ≤15/day within these guardrails; pause and ask me only when
   confidence is low or a reply needs a human." The primitives exist
   (`cron/send-due-touches.ts`, `sequencing.ts`, the reply classifier,
   suppression) — what's missing is the **policy object** + a confidence gate.
3. **Reply → action, autonomously.** `reply.ts` already classifies replies.
   Close the loop: positive reply → draft the response → **propose times and
   book the meeting on the user's calendar.** Owning *reply → meeting booked* is
   the single most pay-worthy outcome, and becomes the north-star metric and the
   pricing unit.

## Act 2 — Build the compounding moat (why they can't churn or copy you)

A drafting tool is a commodity. The moat is **the user's own outcome data**,
which the app already captures (`sent_messages`, `replies`, `evidence_packs`
embeddings) and nobody else has.

4. **The learning flywheel — "it learns what gets *you* replies."**
   - *Win/loss analysis:* correlate sent-message features (opener, length,
     evidence type, send time) with `replies`.
   - *Per-user voice model:* every sent-and-replied email sharpens the draft
     model — measurably.
   - *Target propensity scoring:* before spending ~$0.085 researching a target,
     predict reply-likelihood from embedding similarity to past wins — research
     the likely converters, skip the duds. Improves margin *and* quality at once.
5. **Deliverability & sender-reputation infrastructure.** Inbox warmup,
   SPF/DKIM/DMARC validation at connect time, per-domain daily send caps,
   bounce/complaint handling, spam-word linting. Volume sending without this
   burns the user's domain and churns them in week 2. Unsexy, hard, valued.

## Act 3 — Scale into a system, not a single-player tool

6. **Multi-channel.** Generalize "touch" beyond Gmail (LinkedIn). A mixed
   email+LinkedIn sequence is table stakes in this price band.
7. **System-of-record, or sync to theirs.** Pipeline stages, "meeting booked,"
   reply outcomes — own a lightweight CRM view or two-way sync to
   HubSpot/Salesforce. "OutreachOS runs the top of funnel and hands warm, booked
   meetings to your CRM."
8. **Teams & enterprise trust surface.** Seats, shared inboxes, role-based
   approval policies, an **audit log of every autonomous send**, and
   explainability (lean on the already-sourced evidence). The security hardening
   (SSRF + header-injection fixes, tenant isolation) is part of *this* story — it
   is what lets you pass a security questionnaire when a sales team wants in.

---

## How the money evolves

Today's model meters **targets processed** — correct now (tracks cost linearly).
As the Act 1 booking loop proves out, evolve toward **outcome-aligned pricing**:
a usage base plus a premium tied to *meetings booked* / *replies handled
autonomously*. People pay 10× more for "booked me 4 meetings" than "processed
200 targets" — but that repricing is only credible once you own the outcome.

---

## Recommended sequence

1. **Durable server-side pipeline** (Act 1.1) — keystone; kills the worst
   credibility bug. **← building now.**
2. **Reply → auto-draft → book meeting** (Act 1.3) — the demo moment + north star.
3. **Campaign Autopilot policy + confidence gate** (Act 1.2) — "runs while I sleep."
4. **Deliverability layer** (Act 2.5) — before volume sending is loosed.
5. **Win/loss + propensity scoring** (Act 2.4) — the compounding wedge.

The one-sentence version: go from *a copilot that drafts* to *an autonomous SDR
that books meetings and gets smarter every week*, with the trust surface
(durability, guardrails, deliverability) that lets people actually let it run.
</content>
