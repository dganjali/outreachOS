# OutreachOS — TODO

Sorted by ship-blocker / pre-launch / post-launch. See full audit in conversation history.

---

## P0 — fix before going live (a few hours)

### Security holes

- [ ] **Cron is open to the world if `CRON_SECRET` is unset** — `api/cron/poll-gmail.ts:16` is `if (cronSecret) { check }`. Fail-closed instead: `if (!cronSecret || auth !== ...) return 401`.
- [ ] **No rate limit on agent endpoints** — one user can fire `/api/agents/target` in a loop and burn the Anthropic budget. Add per-user-per-minute counter (cheapest: count rows in `agent_runs` from last 60s; or Vercel KV). Hard daily cap too.
- [ ] **Outgoing emails have no unsubscribe / sender identity footer** — CAN-SPAM/GDPR require it. Reply Router *handles* unsubscribes but the outgoing email itself doesn't include the link. Inject in `buildRfc2822` (`api/_lib/gmail.ts:152`) or have the sequence prompt always include one.

### Bugs

- [ ] **`createDraft` returns possibly-null `threadId`** — `api/_lib/gmail.ts:219` destructures `j.message.threadId`. Gmail's draft API can return null when no `threadId` was passed. Guard or fallback.
- [ ] **`requireUser.accessToken` field is never consumed** — `api/_lib/auth.ts:26`. Either use it (e.g., for user-scoped Supabase calls) or drop it.

---

## P1 — first week after launch

### Architecture cleanups

- [ ] **Centralize env access** — `ENCRYPTION_KEY`, `CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` are read via `process.env.X` in three files. `api/_lib/env.ts` only handles 4 of 8 vars. Move all of them into `env.ts`.
- [ ] **De-duplicate `required()`** — defined in `api/_lib/env.ts:1` *and* `api/_lib/gmail.ts:144`. Pick one home.
- [ ] **Drop the dead `public.emails` table** — `supabase/schema.sql:59` defines + RLS-policies it; no code reads/writes it (everything uses `email_sequences`). Delete in a 004 migration. Same for the original contact-only `replies` RLS that's now redundant with the user_id-scoped policy in 003.
- [ ] **Type drift between server and client** — `MissionMode` lives in `api/_lib/prompts.ts`, `Target`/`Contact`/`EmailSequence` in `src/types.ts`. Move shared shapes to a `shared/` folder both can import, or generate from Supabase via `supabase gen types`.
- [ ] **Anthropic 5xx/529 retry/backoff** — agent endpoints have zero retry. One Claude overload mid-run wastes the whole call. Wrap `messages.create` in 1–2 retries with exponential backoff, only on 5xx / 529.
- [ ] **Cron processes users sequentially** — `api/cron/poll-gmail.ts:37`. With ~30+ active users you'll hit the 60s timeout. Chunk by hash bucket per cron tick, or move to Inngest/QStash.
- [ ] **MissionPage 552-line file** — `src/pages/MissionPage.tsx` holds 3 components (MissionPage, SequenceCard, Touch). Split into 3 files when next touched.

### UX gaps

- [ ] **No first-run guidance** — onboarding doesn't auto-route into "create your first mission". Wire that into the last onboarding step.
- [ ] **Soft delete missions** — `delete cascade` from `missions` annihilates targets/contacts/sequences/sent/replies. Add `archived_at` and filter; protect against fat-finger loss.
- [ ] **`web_search_20250305 max_uses: 5`** — `api/_lib/anthropic.ts:17`. For `count: 10` targeting runs, 5 searches is tight — sparse `why_now`. Bump to 10, monitor cost.
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
- [ ] Three SQL files run **in order** in Supabase prod project (`schema.sql` → `002_agent_layer.sql` → `003_gmail_integration.sql`).
- [ ] Google OAuth client has **both** redirect URIs (localhost for dev, prod domain for prod).
- [ ] OAuth consent screen still in "Testing"? — only listed test users can connect Gmail. Confirm that's intentional for soft-launch.
- [ ] Smoke test: sign-up → onboarding → new mission → run all 5 agents on one target → connect Gmail → save draft → check Inbox after 10 min for the polled reply.
- [ ] `vercel logs --follow` during smoke test — watch for unhandled rejections.

---

## Recommendation

Ship after **P0 (1–5)** done. P1 is real cleanup but none of it blocks "first 10 users." P2 is the next feature epic, not pre-launch hygiene.
