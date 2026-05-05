# OutreachOS — TODO

Sorted by ship-blocker / pre-launch / post-launch.

---

## P0 — fix before going live (DONE)

### Security holes

- [x] **Cron is open to the world if `CRON_SECRET` is unset** — fail-closed.
- [x] **No rate limit on agent endpoints** — 5/min, 50/day via `agent_runs` count.
- [x] **Outgoing emails have no unsubscribe / sender identity footer** — injected in `buildRfc2822`.

### Bugs

- [x] **`createDraft` returns possibly-null `threadId`** — fallback to `''`.
- [x] **`requireUser.accessToken` field is never consumed** — dropped.

---

## P1 — first week after launch

### Architecture cleanups

- [x] **Centralize env access** — all 8 vars now flow through `api/_lib/env.ts`.
- [x] **De-duplicate `required()`** — only lives in `env.ts` now.
- [x] **Drop the dead `public.emails` table** — `004_cleanup.sql`. Same migration tightens redundant `replies` RLS.
- [ ] **Type drift between server and client** — `MissionMode` lives in `api/_lib/prompts.ts`, `Target`/`Contact`/`EmailSequence` in `src/types.ts`. Move shared shapes to a `shared/` folder both can import, or generate from Supabase via `supabase gen types`.
- [x] **Anthropic 5xx/529 retry/backoff** — `createMessageWithRetry` wraps every agent call with 1s+3s backoff on 5xx/529.
- [x] **Cron processes users sequentially** — now runs in parallel chunks of 10.
- [x] **MissionPage 552-line file** — split into `MissionPage.tsx` + `components/SequenceCard.tsx` + `components/SequenceTouch.tsx`.

### UX gaps

- [x] **No first-run guidance** — onboarding finish now routes to `/missions/new?welcome=1` with a tailored heading + copy.
- [x] **Soft delete missions** — `archived_at` column; UI has Archive/Restore + "Show archived" toggle. Dashboard hides archived.
- [x] **`web_search_20250305 max_uses: 5`** — bumped to 10.
- [ ] **Confirm-email + real SMTP for prod** — Supabase free tier limits to 4 emails/hr. Configure a real SMTP provider before public launch.

---

## P2 — M2 features (deferred from MVP)

- [ ] Background job queue (Inngest or Trigger.dev) for long agent batches.
- [ ] Auto-send scheduler for follow-up touches (cron reads `sent_messages.scheduled_send_at`).
- [ ] Suppression list / per-day send caps.
- [ ] Inline draft editing + "regenerate with feedback" prompt.
- [ ] Outlook OAuth as a second provider.

---

## Pre-deploy checkups

- [ ] All 10 env vars from `.env.example` set in Vercel for **Production + Preview + Development**.
- [ ] Four SQL files run **in order** in Supabase prod project (`schema.sql` → `002_agent_layer.sql` → `003_gmail_integration.sql` → `004_cleanup.sql`).
- [ ] Google OAuth client has **both** redirect URIs (localhost for dev, prod domain for prod).
- [ ] OAuth consent screen still in "Testing"? — only listed test users can connect Gmail. Confirm that's intentional for soft-launch.
- [ ] Smoke test: sign-up → onboarding → new mission → run all 5 agents on one target → connect Gmail → save draft → check Inbox after 10 min for the polled reply.
- [ ] `vercel logs --follow` during smoke test — watch for unhandled rejections.
