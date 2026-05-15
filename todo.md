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
- [x] **Type drift between server and client** — shared shapes (`MissionMode`, `Target`, `Contact`, `EvidencePack`, `EmailSequence`, plus their status/source enums) now live in `shared/types.ts`. `api/_lib/prompts.ts` and `src/types.ts` both import from there; `src/types.ts` re-exports for back-compat with existing page imports.
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

---

# Next initiatives (planning, 2026-05-06)

Three parallel tracks to lift the product from "works" to "feels owned."

## A. "Me" section — living profile + resume coach (deep plan)

**Goal:** today's `ProfilePage` is a static form. Replace it with a living `Me` workspace where the user iterates on their identity over time, sees how it's being used, and gets agent-assisted upgrades. Profile quality is the single biggest lever on reply rate, so this doubles as a retention loop.

### Concept

A `/me` route with three modes the user can flip between:

1. **Snapshot** — at-a-glance "this is who the agent thinks you are," with a completeness score, last-enriched timestamp, and the 3-5 hooks the agent is currently leaning on most.
2. **Workshop** — the editor (today's ProfilePage, but restructured into focused panels instead of one long form). Each panel has an "ask the agent to help" affordance.
3. **History** — a timeline of profile versions + which sequences/replies each version produced. The retention hook: "your reply rate went from 4% → 11% after you tightened your proof points."

### Data model changes

- `profile_versions` table: `id, user_id, snapshot jsonb, created_at, source ('manual' | 'enrich' | 'coach' | 'import'), label text`. Auto-snapshot on every save (debounced). Lets us show diffs and roll back.
- `profile_assets` table: `id, user_id, kind ('resume' | 'portfolio_pdf' | 'case_study' | 'screenshot'), storage_path, parsed_text, parsed_at, source_url`. Resume parsing pulls structured fields out so the agent can cite them by line.
- Extend `profiles`: `headline text`, `pitch text` (one-sentence "what I do"), `target_persona text` (who they sell to), `differentiators jsonb` (array of {claim, evidence}), `completeness_score int` (computed server-side).
- New view `profile_usage_stats` aggregating `agent_runs` + `sent_messages` + `replies` per profile-version-id so the History view has data to render.

### New surfaces

- **`src/pages/Me.tsx`** — replaces `ProfilePage` as the route, hosts the three modes via tabs.
- **`src/pages/me/Snapshot.tsx`** — completeness ring, "agent's read on you" card (LLM-summarized from current profile), recent activity (last 3 sequences sent, last 3 replies, with which proof points were used).
- **`src/pages/me/Workshop.tsx`** — split today's monolithic form into accordion panels: Identity, Pitch, Proof, Voice, Assets. Each panel has:
  - inline editing
  - a "Coach" button → opens a side drawer with agent suggestions (rewrite, tighten, add metric, find example)
  - "used in N sequences" footer so the user sees which fields are load-bearing
- **`src/pages/me/History.tsx`** — vertical timeline. Each card = one version. Hover = diff vs previous. Footer = "12 sequences, 9% reply rate." Click = restore.
- **`src/components/me/CompletenessRing.tsx`** — donut + checklist. Same scoring rubric the server computes.
- **`src/components/me/CoachDrawer.tsx`** — right-side panel. Streams suggestions from a new `/api/agents/coach` endpoint (see below).

### New agent endpoints

- **`api/agents/coach.ts`** — input: `{ field, current_value, profile_context }`; output: 3 candidate rewrites + reasoning + a "what to add" gap list. Reuses `createMessageWithRetry`. Counts toward the daily 50-run cap.
- **`api/agents/parse-resume.ts`** — input: `profile_assets.id`; runs PDF text extract (server-side, `pdf-parse` or similar), then LLM-structures into `{ headline, roles[], wins[], metrics[] }`. Writes back to `profile_assets.parsed_text` + suggests profile field updates the user can accept/decline.
- **`api/agents/profile-summary.ts`** — input: `user_id`; output: 2-3 sentence "agent's read on you" for the Snapshot card. Cache for 24h.

### Resume upload pipeline

- Supabase Storage bucket `profile-assets` (private, RLS scoped to `user_id`).
- Upload flow: drag-and-drop in Workshop → Storage → row in `profile_assets` → trigger `parse-resume` → diff modal showing extracted fields → user accepts → fields merge into `profiles` and a `profile_version` snapshot is created.

### Closing the loop with reply data

The killer feature: tie profile content to outcomes.
- When `sequence.ts` drafts an email, persist which proof points / metrics were referenced (new col `sent_messages.profile_refs jsonb`).
- When a reply lands and is classified, attribute it back to the profile_version that drafted the message.
- History view rolls those up: "version v7 (May 3) — 12 sequences, 2 replies. Most-cited proof: 'Hack the North 2025'."
- Coach drawer reads this — "your 'open-source contributor' line has shipped 8 times with 0 replies; want me to rewrite it?"

### Phasing

- **Phase 1 (1-2 days):** ✅ shipped. `ProfilePage` replaced by `src/pages/Me.tsx` at `/me` (old `/profile` route redirects). Form split into 5 collapsible panels (Identity / Pitch / Proof / Voice / Assets), each with a filled/total pip. Header carries a live completeness ring computed client-side from the same panel scores. `.profile-*` styles retired in favor of `.me-*` (editorial Fraunces headings, accent-ring focus). Save/enrich now route through `useToast` instead of inline banners. No schema changes.
- **Phase 2 (2-3 days):** ✅ shipped. Migration `005_profile_versions.sql` adds `profile_versions(id, user_id, snapshot jsonb, source check-in {manual|enrich|coach|import|restore}, label, created_at)` with own-row RLS. Snapshot helpers live in `src/lib/profileSnapshot.ts` (typed snapshot shape, diff, 10-min coalescing rule — manual saves snapshot at most once per 10 min, non-manual sources always snapshot). Me page split into tabs: `Workshop` (existing accordion) + `History`. `src/pages/me/Workshop.tsx` is the extracted form; `src/pages/me/History.tsx` renders a vertical timeline with per-version diff (before/after columns, expand toggle) and a Restore button that writes the snapshot back to `profiles` and inserts a new `restore`-sourced version row. Enrich now also writes a version row labeled with the source (Apollo / web search). README updated with the new migration.
- **Phase 3 (2 days):** ✅ shipped. Migration `006_coach_agent.sql` extends `agent_runs.agent_type` check to include `'coach'`. New endpoint `api/agents/coach.ts` — POST `{ field, current_value }` → `{ suggestions: [{title, rewrite, why} × 3], gaps: [...] }`. Uses `createMessageWithRetry`, rate-limited via existing `checkRateLimit` (counts toward 5/min, 50/day). `COACH_SYSTEM` prompt in `api/_lib/prompts.ts` enforces specifics-over-generics, no fabrication, distinct angles per rewrite. Six coachable fields: `bio | proof_points | achievements | metrics | writing_tone | example_emails` (identity facts + links intentionally excluded). New `src/components/me/CoachDrawer.tsx` is a right-side dialog with shimmer skeleton, regenerate button, Apply (updates form locally — user still saves to persist), Esc to close, focus-trapped on the close button. `Coach` pill button rendered next to those field labels via `Workshop`'s `Field` component. `agents.coach()` client + `CoachField` type live in `src/lib/api.ts`. `AgentType` union extended in both `api/_lib/runs.ts` and `src/types.ts`.
- **Phase 4 (3-4 days):** ✅ shipped. Migration `007_profile_assets.sql` adds `profile_assets(id, user_id, kind, storage_path, file_name, file_size, mime_type, parsed_text, parsed_fields jsonb, parsed_at, parse_error, source_url, created_at)`, the private `profile-assets` Storage bucket, per-user folder policies on `storage.objects` (`(storage.foldername(name))[1] = auth.uid()::text`), and extends `agent_runs.agent_type` to allow `'parse_resume'`. `pdf-parse` added as a dep. Endpoint `api/agents/parse-resume.ts` downloads from storage via service role, extracts text (skipping pdf-parse's index.js self-test by importing `pdf-parse/lib/pdf-parse.js` directly), truncates to 30k chars, runs LLM through `createMessageWithRetry` with new `PARSE_RESUME_SYSTEM` prompt, writes back `parsed_text` + `parsed_fields` to the asset row. Server enforces same 2MB cap as the client; counts against rate-limit. Frontend: `src/lib/profileAssets.ts` handles direct-to-Storage uploads (path `{user_id}/{kind}/{uuid}.{ext}`), insert, delete, signed URLs. `src/components/me/AssetUploader.tsx` renders dual dropzone (resume + portfolio_pdf — both PDF, 2MB) plus an asset list with parsed/parse-failed tags and per-row delete. `src/components/me/ParseResumeModal.tsx` is the accept/decline diff modal — checkbox per field, "overwrite" warning pill for non-empty conflicts, current vs from-resume side-by-side, "X roles extracted (reference only)" details. Accepting writes a `profile_versions` row with `source='import'`. README updated.
- **Phase 5 (2-3 days):** ✅ shipped. Migration `008_profile_outcomes.sql` adds `profile_version_id` + `profile_refs jsonb` to both `email_sequences` (per-touch keyed object) and `sent_messages` (flat array, scoped to the actual touch), plus a `profile_version_outcomes` view rolling up sent/reply counts and reply rate per version. The sequence agent prompt now requires `profile_refs.{initial,followup_0,followup_1}` with canonical field names; `sequence.ts` validates the structure and stamps the user's latest `profile_versions.id` at draft time. `send.ts` copies the matching touch's refs + the version id onto each `sent_messages` row. History tab fetches `profile_version_outcomes` plus a 500-row sample of `sent_messages.profile_refs` (client-side tally) to render "X sent · Y replies (Z%) · most-cited <field>" on each card. Coach endpoint queries the same data to compute per-field outcomes (filtering out `oof`/`unsubscribe` replies), feeds them to the LLM ("if 5+ sent with 0 replies, take a structurally different angle"), and returns them so `CoachDrawer` can show a pill above the suggestions ("X sent · Y replies · underperforming" badge when applicable). All five Me-section phases shipped.

Phase 1 alone is shippable and high-leverage. Don't bundle.

### Open questions

- Resume parsing on Vercel: `pdf-parse` works in Node serverless, but a 5MB PDF + LLM call may push past the 60s `maxDuration`. May need to defer to a queue (which we said was P2). Phase 4 is the riskiest.
- Versioning every save creates a lot of rows for power users. Coalesce: only snapshot if last snapshot was >10 min ago OR diff > N chars.
- Should Coach suggestions count as agent runs against the 50/day cap? Probably yes, but with a higher cap once tiers exist (see track C).

---

## B. Auth + dashboard polish (short plan)

Concrete bugs to batch into one PR. Aim for half a day.

- [x] **Post-signup redirect:** new `/check-email` page receives the email via router state, polls `supabase.auth.getUser()` every 3s, and forwards to `/onboarding` when `email_confirmed_at` flips. Includes a resend button.
- [x] **Sign-in error surfacing:** detects `Email not confirmed` and renders a dedicated alert + "Resend verification email" button (uses toast for resend result).
- [x] **Forgot-password completion screen:** already implemented — `ForgotPassword.tsx` shows a "Check your email" panel after submission.
- [x] **Dashboard empty state:** already implemented — `Dashboard.tsx` shows the `.empty-illo` graphic + headline + "Create your first mission" CTA when there are no missions.
- [x] **Onboarding → first mission handoff:** verified — `MissionNew.tsx` swaps heading to "Create your first mission" and explains in one sentence what a mission is when `?welcome=1`.
- [x] **Loading & error states audit:** Dashboard and Missions now catch load failures into an `error` state and render a shared `.error-banner` with a Retry button. MissionPage and Inbox already had `error` state and banners. New shared `.error-banner` style added to `index.css`.
- [x] **Toast system:** `src/context/ToastContext.tsx` with `useToast()`; renders a fixed bottom-right stack with success/error/info variants and 4s auto-dismiss. Wired into `App.tsx`.

Defer: account-deletion flow, password change, 2FA — none are blockers.

---

## C. Theme + visual identity

Direction picked: **editorial-with-color** — Fraunces serif headlines + deep forest green brand color (`--accent: #1f5f4a`) on warm off-white paper (`--bg: #fbfaf6`).

- [x] Token pass: full `:root` redefine in `index.css` — `--bg`/`--bg-elev`/`--fg`/`--fg-muted`/`--accent`/`--accent-soft`/`--accent-fg`/`--border`/`--success`/`--warn`/`--danger`, 4px spacing scale (`--space-1`..`--space-8`), radii (`--radius-sm`/`md`/`lg`), and font stacks (`--font-display: Fraunces`, `--font-body: Inter`, `--font-mono`). Legacy `--primary`/`--text` aliases retained so old rules adopt the new palette automatically.
- [x] Fraunces loaded via Google Fonts (`index.html`). Theme color meta tag updated to deep green.
- [x] Global `h1/h2/h3` now use the display serif. Hero + section headlines retuned (lighter weight 500, tighter line-height, no purple gradient on `.ldg-grad-text`).
- [x] Landing accents (`.ldg-*` pill glow, hover halos, CTA card gradient) re-skinned to green via search-and-replace of the old rgba purples. Footer ink switched from navy to dark forest.
- [x] Dashboard converted: `.kpi-value` is serif, `.dashboard-section h2` is serif, mission row hover uses the new accent, empty-illo and "Create Mission" button pick up the brand green via existing token references.

### Remaining rollout

- [ ] Convert Missions → MissionPage → ~~Me~~ → Inbox in that order (one PR per page). Me done as part of Phase 1; remaining: Missions, MissionPage, Inbox. The token aliases mean most surfaces already pick up the new palette; touch-ups are mainly serifying headings and killing lingering hardcoded purples / navy inks.
- [ ] Extract `src/components/ui/` (`Button`, `Card`, `Input`, `Tabs`, `Drawer`, `Badge`) on second use — don't build upfront.
- [ ] Kill `inline style={{ ... }}` props as you touch each page; replace with utility classes or component props.

### Don't

- No design-system rewrite as a pre-req for shipping the Me section. Ship Me Phase 1 in current styles, restyle in the rollout.
- No dark/light toggle in v1 — pick one mode and own it.
- No icon library swap mid-flight unless current icons actively look bad.
