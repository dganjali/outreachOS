# OutreachOS — Shipment-Readiness Audit

_Audit date: 2026-06-06. Reviewer: Claude (Opus 4.8). Scope: full repo on `main` @ `f949b1c`._

---

## Verdict (TL;DR)

**OutreachOS is a genuinely strong "research + draft" tool that is mis-described as an "automated outreach pipeline."** The agent prompts are excellent, the data model and Gmail integration are well-built, and the whole thing compiles and builds clean. But three things stand between it and shipping:

1. **Nothing is deployed and `vercel.json` still points at `CHANGE_ME`.** This is a hard blocker — the frontend can't reach the API until you provision the cloud and paste the real Cloud Run URL.
2. **The product under-delivers vs. its own docs.** The README/ARCHITECTURE promise "the full pipeline runs server-side in one call with SSE progress" and "auto-send" + "polls every ~10 minutes." None of that is wired: the pipeline is orchestrated **client-side** (dies if the tab closes, no progress stream), follow-ups are **manual-only** (the Cloud Tasks worker has no caller), and reply polling is **daily**, with classification on-demand.
3. **A few real correctness/security/cost bugs** (NoSQL operator passthrough, an IDOR on file downloads, and a dashboard that fetches entire collections just to count rows).

None of these are deep — they're a focused 1–2 week hardening pass, not a rewrite. The bones are good.

**Honest one-liner:** it works today as a polished, human-in-the-loop "find targets → research → draft emails → send from Gmail" tool. It is **not yet** the hands-off "mission in → pipeline out" product the marketing copy claims. Decide which one you're shipping, then make the code and the copy agree.

---

## 1. Does it work?

**Builds: yes.** `tsc --noEmit` (frontend), `tsc -p tsconfig.server.json` (server), and `vite build` all pass clean. The stale warning in `daniel-todo.md` ("expect TypeScript errors") is no longer true.

**Runs end-to-end: only after you provision + deploy.** Per `daniel-todo.md`, zero cloud resources exist yet and `vercel.json:6` still has `outreachos-api-CHANGE_ME.a.run.app`. Until that's replaced, the deployed SPA has no backend.

**What actually works once deployed (the manual path):**
- Auth (Firebase, email/pw + Google), onboarding (5 steps), profile enrichment from LinkedIn.
- Create mission → Find targets → Build evidence → Find contacts → Draft sequence → Send/draft via Gmail. All solid.
- Gmail send is the strongest server module: idempotent on `(sequenceId, touchIndex)`, correct threading (`In-Reply-To`/`References`/`threadId`), RFC2047 subject encoding, auto-appended unsubscribe footer, AES-GCM token storage, token refresh with a 60s buffer.
- Reply ingestion (daily cron) + on-demand AI classification.

**What's built but NOT wired (dead or misleading):**
- **Auto-send / scheduled follow-ups.** `api/_lib/queue.ts` (`enqueue`) and `api/tasks/worker.ts` (`send-sequence-touch`) exist, but **nothing calls `enqueue()` anywhere in the codebase.** The worker is a consumer with no producer. Follow-ups must be sent by hand, and the UI even disables follow-up #2 until #1 is manually sent. So "3-touch sequences" are really "one email + two pre-written drafts you send yourself."
- **Server-side pipeline + SSE.** Doesn't exist. `runFullPipeline()` in `src/pages/MissionPage.tsx:148` loops over targets with sequential `await`s on the client.
- **Vector search beyond sequences.** `evidence_packs` and `profile_assets` embeddings are written but never queried (documented as future work).

**Misleading copy to fix now:** `src/pages/Inbox.tsx:107,134` tells users replies refresh "every ~10 minutes," but `daniel-todo.md:220` schedules the poll **daily** (`0 9 * * *`).

---

## 2. Is it cohesive?

**Mostly yes — the UX surface is consistent and the IA is clean.** Nav is Dashboard / Missions / Inbox / Me / Settings. Mode selection (sponsorship / BD / internship / recruiting / sales) flows coherently from mission creation → mode-aware prompts → mode-aware angles. The "Me" workspace (Workshop + History + Coach) is a thoughtful identity hub. Empty states, KPIs, and copy are well-considered.

**The big cohesion crack is doc-vs-reality**, covered above. The second is **internal architecture cohesion**: the frontend talks to the backend through a **Supabase-shaped compatibility shim** (`src/lib/db.ts`) that re-implements a query builder and does deep snake_case↔camelCase conversion on every call. It works, but it means every page still "thinks in Supabase" (`supabase.from('targets').select()...`) against a Mongo backend. It's a clever migration bridge that has quietly become load-bearing. `daniel-todo.md` itself flags it for deletion. Right now it's the main source of latency and the thing most likely to confuse the next engineer.

Minor: the top-bar **search box (`AppLayout`) is non-functional** (local state, never used).

---

## 3. Is the user flow good?

**The manual flow is good and well-taught.** `MissionNew` has excellent placeholder copy that teaches users to write specific, high-signal inputs ("Sponsorship tiers $5k–25k for Hack the North 2026 (1.4k attendees, 60% senior CS)"). Onboarding is smooth.

**The "Run full pipeline" flow is where UX breaks down:**
- It's a **single button that blocks for minutes**. Each agent call hits Claude + up to 10 web searches (20–60s each); the pipeline runs ~16 of them sequentially on the client. Expect **5–15 minutes** of the user staring at "Running pipeline…". If they navigate away or close the tab, **all in-flight work is lost** (the orchestration lives in React state, not the server).
- There's **no per-step progress** — just a global "busy" flag. The architecture doc literally promises SSE progress; users get a spinner.
- The **per-user rate limit is 5/min and 50/day** (`api/_lib/runs.ts`). One full pipeline burns ~16 of the 50 daily runs, so a user gets **~3 full pipelines/day** before being locked out — with no UI surfacing that budget.

Two small flow bugs:
- `Onboarding.handleFinish()` calls `navigate('/dashboard')` immediately followed by `navigate('/missions/new')` — the first is dead.
- Follow-ups are gated behind manually sending the initial email, which is reasonable, but combined with no auto-send it makes the "sequence" feel like a draft folder.

---

## 4. How fast is it?

**Two systemic performance problems, both fixable:**

**(a) Client-orchestrated pipeline = minutes, fragile.** See above. The fix is the server-side orchestrator + SSE the docs already describe. Cloud Run was chosen specifically to kill the 60s timeout — but because requests still flow through Vercel's rewrite proxy and the client drives the loop, you get neither resilience nor progress. Move orchestration server-side.

**(b) N+1 query waterfalls + counts that fetch entire collections.** This is the sneaky one:
- `MissionPage` loads the mission, then targets, then **per target** loads contacts + evidence, then **per contact** loads sequences. For 10 targets × 3 contacts that's ~50 sequential HTTP round-trips through the shim → `/api/data` → Mongo, each re-fetching full documents with no projection.
- `Dashboard` is worse: it issues 7 queries, then **4 more per mission**. And every `count: 'exact', head: true` is implemented by the shim as **"fetch all matching documents and return `.length`"** (`src/lib/db.ts` `exec()` + `api/data/router.ts` `find()` has no count/limit/projection pushdown). So showing "1,240 targets" downloads all 1,240 full target documents. At any real data volume this is a latency **and** egress **and** Mongo-read cost bomb.
- `api/data/router.ts` does `sort` and `limit` **in application memory** after loading the full result set — there's no DB-side pagination anywhere.

Frontend bundle is fine (448 KB / 119 KB gzip, no code-splitting but acceptable for v1).

---

## 5. Is the architecture good enough for the app's purpose?

**For the purpose (per-user agentic outreach, single-tenant, moderate scale): yes, with caveats.** The choices are sound:
- **Cloud Run + Express** is right for long-running agent calls.
- **Firebase Auth** verification is correct (`verifyIdToken`), and the `forUser(uid)` ownership wrapper is a clean RLS replacement.
- **Mongo schema** is well-designed: denormalized `userId` everywhere for O(1) ownership, good compound indexes, idempotency uniques (`sent_messages` on `(sequenceId,touchIndex)`, `replies` on `gmailMessageId`), a TTL on telemetry, and correctly-defined Atlas Vector Search filters.
- **Voyage + Atlas Vector Search** for "retrieve my own emails that got replies" is a genuinely good pattern and the one vector path that's actually wired.

**Caveats / debt that will bite at scale:**
- **The `OWNERSHIP` map in `api/_lib/db.ts` is dead code.** It declares `viaMission`/`viaTarget` modes but `ownFilter()` ignores them (`void mode`) and filters purely on `userId`. Security is therefore 100% dependent on every document having `userId` correctly denormalized at write time. That happens to hold (the wrapper stamps it), but the misleading abstraction is a foot-gun, and `daniel-todo.md` notes there are **no tests** on the one thing the whole security model rests on.
- **No DB-side pagination/projection** (see perf). The `find()` wrapper needs `sort`/`limit`/`projection`/`count` support before any user has thousands of rows.
- **The Supabase shim** is architecture debt — commit to deleting it or own it deliberately.
- **No runtime validation** (schemas are TS-only). Fine for a hackathon; add Zod at the API boundary before untrusted scale.
- **No structured logging / tracing / error monitoring.** `console.error` only. You'll be blind in prod.

---

## 6. Security findings

| # | Severity | Finding | Location | Fix |
|---|---|---|---|---|
| S1 | **High** | **NoSQL operator injection.** The frontend shim preserves `$`-prefixed keys and the server only strips `userId` from the filter, passing arbitrary Mongo operators (`$where`, `$regex`, …) straight into `find()`. Cross-tenant reads are blocked (top-level `userId:uid` is ANDed), but `$where` enables CPU-DoS and `$regex` enables ReDoS within a user's own scope. | `api/data/router.ts` `sanitizeFilter` + `src/lib/db.ts` `deepKeyMap` | Whitelist allowed operators/fields per collection; reject `$where`/`$function`; or strip all `$` keys server-side and rebuild filters explicitly. |
| S2 | **Medium** | **IDOR on signed downloads.** `/_storage/sign-download` "trusts the JWT" and does not verify the requesting uid owns the `users/{uid}/...` path. Anyone authenticated who learns/guesses a path gets a signed URL. | `api/data/router.ts:50-57` (acknowledged TODO) | Verify the path's `{uid}` segment equals the caller's uid before signing. |
| S3 | Low | **Worker has no app-layer auth** — relies entirely on Cloud Run "require authentication" + IAM being configured correctly. If that IAM step is skipped at deploy, `/api/tasks/worker` is an open "send email as any user" endpoint. | `api/tasks/worker.ts` | Add an OIDC token check or shared secret as defense-in-depth; document the IAM step as mandatory. |
| S4 | Low | **`sign-upload` infers `kind` from a regex on the path, defaulting to `resume`.** Low impact but lets a client mislabel asset kinds. | `api/data/router.ts:42-43` | Require explicit `kind` param. |

Auth itself (Firebase verification, cron secret, AES-GCM token encryption) is implemented correctly. No secrets are committed (`.env` is gitignored; `.env.example` is placeholders).

---

# Your TODO to ship

Ordered. P0 = blocks launch; P1 = needed before you charge money / scale; P2 = fast-follow.

### P0 — can't ship without these
1. **Provision + deploy** per `daniel-todo.md` (GCP → Firebase → Atlas → Voyage → Secret Manager → GCS → Cloud Tasks → Cloud Run → Scheduler → Vercel). ~3–4 hrs happy path.
2. **Replace `CHANGE_ME` in `vercel.json`** with the real Cloud Run URL after first deploy. (Also `CLOUD_TASKS_TARGET_URL` and the OAuth redirect URIs.)
3. **Decide the auto-send story and make code + copy agree.** Either (a) wire `enqueue('send-sequence-touch', …, {scheduleTime})` from the send handler so follow-ups actually schedule, or (b) rip out the unused queue/worker and reword the UI so users know follow-ups are manual.
4. **Fix the Inbox "~10 minutes" copy** (or bump the cron frequency to match the promise).
5. **S1 (NoSQL operator injection)** and **S2 (download IDOR)** — both are small, both are real.

### P1 — before you charge or scale
6. **Move pipeline orchestration server-side with SSE** (matches the docs, survives tab close, removes the Vercel-proxy timeout risk, unlocks real progress UI).
7. **Push sort/limit/count/projection into Mongo.** Kill the "count = fetch entire collection" behavior. This is a cost bug as much as a perf bug.
8. **Add usage metering + caps** (you can't bill safely without it — see cost section).
9. **Prompt caching + trim web search.** Cache the static system prompts; drop `WEB_SEARCH_TOOL.max_uses` from 10→~5; consider `claude-sonnet-4-6` (same price, better, and unlocks the token-efficient `web_search_20260209` with dynamic filtering).
10. **Tests on `forUser()` ownership** — the entire tenancy model rests on it and has zero coverage.
11. **Error monitoring + structured logs** (Sentry/Cloud Logging).

### P2 — fast-follow
12. Migrate off the Supabase shim (or formally adopt it).
13. Suppression list + per-day send caps (deliverability/compliance).
14. Inline draft editing / regenerate-with-feedback.
15. Use the already-populated `evidence_packs` / `profile_assets` vector indexes (cross-mission dedup, snippet retrieval).
16. Outlook; the non-functional global search box; S3/S4.

---

# Business model

**The core economic fact:** every unit of value (a researched target, a verified contact, a drafted sequence) costs you real money in Claude tokens + web search + (optionally) Apollo credits, and that cost **scales linearly with usage with no caching today**. So the model must **meter and cap** — flat "unlimited" pricing will be margin-negative for power users.

**Recommended shape — credits or capped tiers, priced on outcomes:**

| Tier | Price | Includes | Your est. variable cost | Notes |
|---|---|---|---|---|
| **Free trial** | $0 | 1 mission, ~10 targets, drafts only (no auto-send) | ~$2–3 one-time | Proves value; cap hard. |
| **Starter** | $39/mo | ~10 full pipelines/mo, Gmail send, web-search sourcing | ~$25/mo | Thin margin — keep caps tight. |
| **Pro** | $99–149/mo | ~40 pipelines/mo, Apollo verified emails + enrichment, priority | ~$60–90/mo + Apollo | The real plan; Apollo is the upsell. |
| **Credits add-on** | $X/credit | 1 credit = 1 "researched + verified contact" | — | Aligns price with the cost driver. |

**Principles:**
- **Meter the cost driver, not seats.** Bill on pipelines / verified contacts / sent sequences — the things that consume web searches and Apollo credits.
- **Target ≥70% gross margin** → price each unit at ~3–3.5× its loaded cost. A ~$2.50 pipeline → meter at ~$8 of plan value, or bundle ~10 into a $79 plan.
- **Apollo is the wildcard.** Verified emails are the premium differentiator, but Apollo's API/enrichment is gated to higher-priced plans and has its own per-credit cost. Make Apollo a paid-tier feature and pass the credit cost through; keep web-search sourcing as the free/Starter fallback.
- **Deliverability is a feature and a liability.** Per-day send caps, suppression lists, and the unsubscribe footer (already present) protect both your users' domains and your platform reputation. Ship the suppression list before volume sending.

---

# Cost analysis (based on the APIs you use)

**Authoritative rates (verified 2026-06-06):**
- **Claude Sonnet 4.5** (`claude-sonnet-4-5`, your configured model): **$3 / 1M input tokens, $15 / 1M output tokens** (standard Sonnet tier; same price as Sonnet 4.6).
- **Web search tool** (`web_search_20250305`, `max_uses: 10`): **$10 / 1,000 searches = $0.01/search**, _plus_ the returned results are billed as input tokens (the dominant hidden cost — each search can inject 5–15K tokens).
- **Voyage `voyage-3` embeddings:** ~$0.06 / 1M tokens — effectively free at your volumes.
- **Prompt caching:** writes 1.25× (5-min) / 2× (1h), reads 0.1×. **You use none today** — leaving an easy ~10% input-cost reduction on the table for repeated system prompts.

**Per-agent estimated cost (typical run; web-search agents assume ~4–5 searches):**

| Agent | LLM calls | Web searches | Est. cost/run |
|---|---|---|---|
| Targeting (web mode) | 1 | ~5 | $0.15–0.25 |
| Targeting (Apollo mode) | 2 | ~5 | $0.15–0.25 + Apollo credits |
| Evidence | 1 | ~5 | $0.15–0.25 |
| Contacts (web mode) | 1 | ~4 | $0.10–0.20 |
| Sequence | 1 | 0 | $0.02–0.05 |
| Reply classify | 1 | 0 | $0.01–0.03 |
| Enrich profile | 1 | ~4 | $0.10–0.20 |
| Parse resume / Coach | 1 | 0 | $0.02–0.04 |

**"Run full pipeline" (targeting + top-5 × [evidence + contacts + sequence] = ~16 calls, ~45 web searches):**
> **≈ $2.00–3.00 per pipeline run.** (~$0.45 of that is web-search fees; the rest is search-result tokens.)

**Per active user / month:**
- Light (3–5 pipelines + some manual + replies): **~$8–18/mo**.
- Heavy (daily use): **$50–150/mo**.
- Hard ceiling from the 50-runs/day rate limit: ~50 × ~$0.22 ≈ **$11/day ≈ $330/mo** worst case per user.

**Fixed infra (small scale):**

| Service | Cost |
|---|---|
| Cloud Run | ~$0 idle (scale-to-zero) → ~$10–40/mo light traffic |
| MongoDB Atlas | M0 free (no real vector-search perf) → **M10 ~$57/mo** once you need vector search at scale |
| Voyage AI | cents/mo |
| GCS + Cloud Tasks + Scheduler + Secret Manager | ~$0–5/mo |
| Firebase Auth | free to 50k MAU |
| Apollo.io (optional) | ~$49–149/seat/mo + API/credit costs, plan-gated |
| **Fixed total** | **~$60–100/mo** at launch (mostly Atlas + optional Apollo) |

**Cost levers (in priority order):**
1. **Trim `web_search.max_uses` 10→5** — directly caps the #1 cost and the token bloat. Biggest single win.
2. **Upgrade to `claude-sonnet-4-6` + `web_search_20260209`** — same token price, and dynamic filtering trims search-result tokens before they hit context.
3. **Add prompt caching** on the static system prompts.
4. **Cache/dedupe research** — don't re-run evidence/contacts for a target you researched last week (the evidence vector index you already populate is perfect for this).

---

## Bottom line

The vision is real and the hardest parts (prompt quality, Gmail, data model, vector retrieval) are already good. What's left is **(1) actually deploy it, (2) make the product do what the docs say or change the docs, (3) fix a handful of correctness/security/cost bugs, and (4) put metering in before you charge.** Two focused weeks gets you to a defensible v1.
