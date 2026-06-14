# OutreachOS — Road to First Users

The one list. Do it top to bottom and you go from "branch on disk" to "an app you can put in front of real users and charge for." Everything else (old deploy notes, the full audit) lives in git history.

**Where it stands today:** Code compiles and builds clean. The manual flow works (sign up → onboard → mission → find targets → research → draft → send via Gmail). What's missing for users: it's **not deployed**, a few features **don't match the marketing**, there's **no billing**, and there's **no way to get + measure users yet**.

**Definition of "ready for users":** a stranger can hit a URL, sign up, run one mission end-to-end without you babysitting it, hit a paywall, pay, and you can see they did — without it costing you more than they pay.

---

## ✅ Already done (this branch)
- [x] **S1 — NoSQL operator injection** locked down (`api/data/router.ts` `sanitizeFilter` allowlist → 400).
- [x] **S2 — storage IDOR** fixed (`ownsStoragePath` gates sign-download + remove).
- [x] Unit tests for both (`npm test`, 8 passing) + test files excluded from the prod build.

---

## PHASE 1 — Get it live (you can't get users for localhost)
> Goal: the real app reachable at a URL. ~½ day of cloud setup.

- [ ] **Provision the cloud** (one-time): GCP project + enable APIs (run, cloudbuild, artifactregistry, secretmanager, cloudtasks, cloudscheduler, storage, identitytoolkit, firebase) → Firebase Auth (Email/Password + Google) → MongoDB Atlas (M0 to start; **M10 ~$57/mo when you need vector search to actually work**) → Voyage AI key.
- [ ] **Secrets → Secret Manager:** `ANTHROPIC_API_KEY`, `MONGODB_URI`, `VOYAGE_API_KEY`, `ENCRYPTION_KEY` (`openssl rand -base64 32`), `CRON_SECRET` (`openssl rand -hex 32`), `GOOGLE_CLIENT_ID/SECRET`, `FIREBASE_SERVICE_ACCOUNT_JSON`, optional `SERPER_API_KEY`, `EMAILFINDER_API_KEY`, `MILLIONVERIFIER_API_KEY`.
- [ ] **Init the DB:** `MONGODB_URI=… npm run mongo:init` (creates collections, indexes, vector indexes).
- [ ] **GCS bucket** + **Cloud Tasks queue** (`outreach-jobs`) + **cloud-tasks-invoker** service account.
- [ ] **Deploy Cloud Run:** `gcloud builds submit --config=cloudbuild.yaml`, then grab the service URL.
- [ ] **Wire the URL in 3 places** (this is the classic miss):
  - [ ] `vercel.json` → replace `outreachos-api-CHANGE_ME.a.run.app` with the real Cloud Run URL.
  - [ ] `CLOUD_TASKS_TARGET_URL` env → `<service-url>/api/tasks/worker`.
  - [ ] Google OAuth redirect URIs → add the Vercel + Cloud Run callback URLs.
- [ ] **Lock down the worker:** set Cloud Run to "require authentication" and grant `roles/run.invoker` to `cloud-tasks-invoker@…`. (Without this, `/api/tasks/worker` is an open "send email as anyone" endpoint.)
- [ ] **Cloud Scheduler** → `poll-gmail` with the `CRON_SECRET` bearer header.
- [ ] **Deploy frontend:** set `VITE_FIREBASE_*` in Vercel, `vercel --prod`. Add the Vercel domain to Firebase **Authorized domains**.
- [ ] **Smoke test the happy path** on the live URL: sign up → onboarding writes a `profiles` doc → create mission → run targeting → connect Gmail → send a draft. Watch the Atlas collections fill in.

---

## PHASE 2 — Make it honest & unbreakable
> Goal: the product does what the UI says, and a closed tab / big account doesn't break it. **This is the real gap between "demo" and "product."**

- [ ] **Server-side pipeline + progress (highest-impact UX fix).** Today `runFullPipeline()` runs ~16 agent calls **in the browser** — it takes 5–15 min and **dies if the user closes the tab**. Move orchestration into one Cloud Run endpoint (e.g. `POST /api/agents/pipeline`) that streams progress (SSE). The ARCHITECTURE doc already claims this exists; make it true. `api/agents/sequence.ts:fetchReplyExemplars` is the pattern to follow for server-side fan-out.
- [ ] **Decide the auto-send story** (right now it's vaporware): the Cloud Tasks worker (`api/tasks/worker.ts`) and `enqueue()` (`api/_lib/queue.ts`) exist but **nothing calls `enqueue()`** — follow-ups are manual-only. Either:
  - [ ] **(A) Wire it:** call `enqueue('send-sequence-touch', …, { scheduleTime })` from the send handler so follow-ups auto-schedule at `wait_days`. (This is a real feature users will expect from a "sequence" tool.) **OR**
  - [ ] **(B) Cut it:** delete the dead queue/worker and reword the UI so "3-touch sequence" reads as "1 email + 2 ready-to-send drafts."
- [ ] **Fix the lies in the copy:** Inbox says replies refresh "every ~10 minutes" but the cron is **daily** (`0 9 * * *`). Either bump the schedule or fix the text. Same for ARCHITECTURE.md's "one server-side call with SSE" + "auto-send unblocked" claims.
- [ ] **Kill the count-by-fetch-everything bug.** Dashboard's `count:'exact'` is implemented as "download every matching doc and take `.length`" (`src/lib/db.ts` + `api/data/router.ts` have no DB-side count/limit/projection). One power user with thousands of targets = slow dashboard + real Mongo/egress cost. Add `count`/`limit`/`sort`/`projection` pushdown to the `find()` wrapper.
- [ ] **Surface the rate-limit budget.** A "full pipeline" burns ~16 of the 50/day cap (`api/_lib/runs.ts`) → users get ~3 runs/day with no warning. Show remaining budget in the UI; raise/segment the limit by plan.
- [ ] **Error monitoring + structured logs** (Sentry or Cloud Logging). Right now it's `console.error` — you'll be blind the first time something breaks in prod.
- [ ] **One test on `forUser()` ownership.** The entire multi-tenant security model rests on it and has zero coverage.
- [x] **Contact-pipeline follow-ups** (Serper + emailfinder.dev landed this branch — discovery + SMTP-verified resolution, no more shipped email guesses):
  - [x] Add a dedicated verifier gate (MillionVerifier, `MILLIONVERIFIER_API_KEY`) after resolution, downgrade catch-all/unknown to `emailStatus: 'likely'`, discard `invalid`. (`api/_lib/email-verifier.ts` + cascade in `email-resolver.ts`.)
  - [x] Migrate domain resolution (`resolveCompanyDomain`) onto Serper, with LLM web_search as fallback when Serper is off/empty. (`api/_lib/company-enrich.ts`.)
  - [x] `emailResolver` provenance field on `ContactDoc` (which rung resolved each email).
  - [x] Loop-for-another-contact: discovery hands a ranked pool; resolver keeps deliverable rows until 3 kept or 8 attempts, falls back to top-ranked display-only rows. (`api/agents/contacts.ts` `resolvePoolWithBudget`.)

---

## PHASE 3 — Charge money (don't onboard users you can't bill)
> Goal: a paywall that protects your margin. **Do this before broad signups** — every pipeline costs you real money.

- [ ] **Meter the cost driver.** Count + store per-user **pipeline runs** (or verified contacts / sent sequences) — not seats. You already log `agent_runs`; aggregate from there.
- [ ] **Hard caps per plan** enforced server-side (extend `checkRateLimit`): free trial → small cap; paid → plan cap; over cap → upsell, not silent failure.
- [ ] **Stripe** (Checkout + Customer Portal + webhook → set plan/limits on the `profiles` doc).
- [ ] **Pricing (grounded in real cost — a full pipeline run costs you ~$2–3, mostly web search):**
  - Free trial: 1 mission, ~10 targets, drafts only. (Costs you ~$2–3 once.)
  - Starter ~$39/mo: ~10 pipelines/mo + Gmail send. (Keep caps tight — thin margin.)
  - Pro ~$99–149/mo: ~40 pipelines + verified emails (emailfinder.dev — the upsell) + priority.
  - Aim ~3–3.5× your loaded cost per unit for ~70% gross margin.
- [ ] **Cut the variable cost while you're here (protects every plan's margin):**
  - [ ] Drop `WEB_SEARCH_TOOL.max_uses` 10 → ~5 (`api/_lib/anthropic.ts`) — biggest single lever.
  - [ ] Move model `claude-sonnet-4-5` → `claude-sonnet-4-6` (same price, better) and use `web_search_20260209` (dynamic filtering trims search-result tokens).
  - [ ] Add prompt caching on the static agent system prompts.
  - [ ] Don't re-research a target you did last week — use the `evidence_packs` embeddings you already write (vector dedup).

---

## PHASE 4 — Actually get users
> Goal: the funnel from "stranger" to "paying user" exists and you can see it.

- [ ] **Landing page that sells the outcome** ("cold outreach pipeline in one click"), not the tech. Real before/after example email. Clear CTA → sign up.
- [ ] **Frictionless first run.** New user should reach a *useful drafted email* in <5 min. Consider a prefilled demo mission so they see value before doing work. (Onboarding is already decent — tighten it.)
- [ ] **Analytics:** signup → onboarding-complete → first mission → first pipeline → first send → paywall → paid. (PostHog/Plausible.) You can't improve what you can't see.
- [ ] **Deliverability guardrails before volume sending:** suppression list + per-day send caps (the unsubscribe footer already exists). Protects your users' domains *and* your platform reputation.
- [ ] **Legal minimum:** privacy policy + terms (you store Gmail tokens + scrape contact data — non-negotiable for real users).
- [ ] **Get the first 10 users by hand.** You're the target persona — run your own outreach with it, fix what hurts, then expand. Add a feedback channel (Intercom/email) and watch session analytics for where they drop.

---

## Quick reference

**Cost cheat-sheet** (Sonnet tier $3/M in, $15/M out; web search $10/1k + result tokens; Voyage ≈ free; no caching yet):
| Thing | Cost |
|---|---|
| One agent run w/ web search | ~$0.15–0.25 |
| Full pipeline (~16 calls) | **~$2–3** |
| Typical active user / mo | ~$8–18 |
| Fixed infra at launch | ~$60–100/mo (mostly Atlas M10) |

**Commands:** `npm run dev` (frontend) · `npm run server:dev` (API :8080) · `npm test` · `npm run build` · `npm run server:build` · `npm run mongo:init`.

**The one-sentence version:** deploy it (Phase 1) → make it match its own promises and not fall over (Phase 2) → put a metered paywall in front (Phase 3) → point a funnel at it and watch (Phase 4).
