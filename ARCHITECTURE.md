# Architecture

> **As of the MongoDB + Firebase + Google Cloud migration.**
> If you're reading this on the old Supabase + Vercel branch, get rebased.

## TL;DR — request flow

```
                ┌───────────────────────────────────────────┐
                │  React SPA (Vite, hosted on Vercel)        │
                │   - src/firebaseClient.ts — Firebase Auth │
                │   - src/lib/api.ts        — REST client   │
                │   - src/lib/db.ts          — chain shim    │
                └──────────────────┬────────────────────────┘
                                   │   Authorization: Bearer <firebase-id-token>
                                   │
                                   ▼  (Vercel rewrites /api/* to Cloud Run)
                ┌───────────────────────────────────────────┐
                │  Cloud Run service: outreachos-api         │
                │   server/index.ts (Express)                │
                │     ├─ /api/agents/* — LLM agents          │
                │     ├─ /api/data/*   — CRUD + storage sign │
                │     ├─ /api/gmail/*  — Gmail send          │
                │     ├─ /api/integrations/gmail/* — OAuth  │
                │     ├─ /api/cron/poll-gmail  ← Scheduler  │
                │     └─ /api/tasks/worker     ← Tasks       │
                └─────┬────────────┬────────────┬───────────┘
                      │            │            │
              ┌───────▼──┐ ┌──────▼─────┐ ┌────▼─────────┐
              │ MongoDB  │ │ Cloud      │ │ Cloud Tasks  │
              │ Atlas    │ │ Storage    │ │ + Scheduler  │
              │ + Vector │ │            │ │              │
              │  Search  │ │            │ │              │
              └──────────┘ └────────────┘ └──────────────┘
                      │
              ┌───────▼──────────┐    ┌────────────────┐
              │ Vertex AI        │    │ Vertex AI      │
              │ gemini-embedding │    │ Gemini 2.5     │
              │ -001 (1024-d)    │    │ flash + pro    │
              └──────────────────┘    └────────────────┘
```

## Identity & ownership

- **Firebase Auth UID** is the canonical user id. Every Mongo document carries `userId: <firebase-uid>` (denormalized even on docs that are owned transitively, e.g. `contacts.userId`).
- **No row-level security.** Mongo doesn't have RLS. Security is in `api/_lib/db.ts`:
  - `forUser(uid).collection(name)` returns a wrapper that auto-injects `{ userId: uid }` on every read/write filter.
  - `adminDb()` is the escape hatch — only used in cron jobs, init scripts, and the task worker (which validates uid in the task payload).
  - Rule: never `import { adminDb }` outside of those three call sites.

## Data model

Twelve collections. Most own their data by `userId`; a few (contacts, evidence_packs, email_sequences, sent_messages, replies, targets) also denormalize `missionId` / `targetId` to keep ownership queries O(1) without `$lookup`.

| Collection | Owns by | Notes |
|---|---|---|
| `profiles` | userId | One per user. Sender's identity, bio, proof points. |
| `profile_versions` | userId | Immutable snapshots. Used by Coach agent. |
| `profile_assets` | userId | Resumes/PDFs in GCS. `embedding` field for vector search. |
| `missions` | userId | One outreach campaign. Mode (`sales`, `bd`, ...). |
| `targets` | userId, missionId | Companies. From web_search. |
| `contacts` | userId, missionId, targetId | People at targets. Discovery via Serper / web_search; emails resolved (not guessed) via emailfinder.dev SMTP verification or a real scraped address. `emailStatus: 'verified'` means verified. |
| `evidence_packs` | userId, missionId, targetId | 4–6 sourced bullets. **Embedded**. |
| `email_sequences` | userId, missionId | Initial + follow-ups. **Embedded** when replied. |
| `sent_messages` | userId | One per actual Gmail send. Idempotent on (sequenceId, touchIndex). |
| `replies` | userId | Polled from Gmail. Classified by reply agent. |
| `agent_runs` | userId | Telemetry. TTL 30 days. |
| `user_integrations` | userId | Encrypted Gmail tokens. |

Full TS shapes in [`shared/schemas.ts`](./shared/schemas.ts). Indexes (including the three Atlas Vector Search indexes) are in `INDEX_SPEC` + `VECTOR_INDEX_SPEC` in the same file and created by `npm run mongo:init`.

## Vector retrieval

Five vector indexes, all 1024-d cosine (Vertex `gemini-embedding-001`):

1. **`style_exemplars.embedding`** + `style_exemplar_vector_idx` — **active**. The engine retrieves a persona's most relevant gold emails as few-shot voice anchors (`api/_lib/assemble.ts → fetchExemplars`).
2. **`context_facts.embedding`** + `context_fact_vector_idx` — **active**. Relevance-ranks the context bank to select the facts worth citing for a given draft (`api/_lib/assemble.ts → assembleAllowedFacts`).
3. **`email_sequences.embedding`** + `sequence_vector_idx` — populated on write; future use: retrieve past replies-getting emails as earned exemplars.
4. **`evidence_packs.embedding`** + `evidence_vector_idx` — populated on write; not yet read. Future use: cross-mission target dedup.
5. **`profile_assets.embedding`** + `asset_vector_idx` — populated for resume chunks; future use: snippet-level retrieval into prompts.

All are best-effort: callers `try { embed }` and fall back (recency / full set) on failure. Vector Search isn't required for the rest of the app to work.

## Auth & token flow

1. Frontend gets a Firebase ID token via the Firebase SDK (`getIdToken()`).
2. Frontend attaches it: `Authorization: Bearer <token>`.
3. Cloud Run handler calls `requireUser(req, res)` from `api/_lib/auth.ts`, which uses `firebase-admin.auth.verifyIdToken(token)`.
4. Verified UID → `forUser(uid)` → all DB operations scoped to that uid.

OAuth tokens for Gmail are a separate path:
- Stored encrypted (AES-GCM with `ENCRYPTION_KEY`) in `user_integrations`.
- `getActiveAccessToken(uid)` returns a fresh access token, refreshing if needed.

Cron + task worker auth:
- `Authorization: Bearer ${CRON_SECRET}` from Cloud Scheduler → cron handlers validate via `requireCronSecret`.
- Cloud Tasks → worker uses OIDC token (set up Cloud Run "require authentication" + grant `roles/run.invoker` to the task service account; see daniel-todo.md §9).

## Storage

Object storage uses signed URLs end-to-end — bytes never proxy through the API server.

**Upload flow:**
1. Frontend calls `POST /api/data/_storage/sign-upload` with `{ path, contentType }`.
2. Server returns a v4 signed PUT URL valid for 5 min.
3. Frontend PUTs bytes directly to GCS.
4. Frontend posts the GCS path to `POST /api/data/profile_assets` to register the row in Mongo.

**Download flow:**
1. Frontend calls `POST /api/data/_storage/sign-download` with `{ path }`.
2. Server returns a v4 signed GET URL valid for 10 min.

Both flows are uid-authenticated. GCS path convention: `users/{uid}/{kind}/{timestamp}_{filename}`.

## Job queue

Cloud Tasks dispatches via `enqueue(kind, payload, { scheduleTime? })` in `api/_lib/queue.ts`. All tasks land at `POST /api/tasks/worker`, which dispatches by `kind`:

- `send-sequence-touch` — implemented. Sends a queued touch via Gmail at its `scheduledSendAt`.
- `embed-evidence-pack`, `embed-email-sequence`, `poll-gmail-for-user` — stubs.

Cloud Scheduler triggers cron-style jobs (currently only daily Gmail polling).

## Why these choices

- **Cloud Run over Vercel functions:** kills the 60s timeout. The full mission pipeline (target → evidence × N → contacts × N → sequence × N) can now run server-side as one call with SSE progress, instead of the client-side orchestration we used to do.
- **MongoDB over staying on Postgres:** the hackathon is sponsored by MongoDB — and Atlas Vector Search is genuinely useful for the "retrieve my own past winners" pattern. Postgres + pgvector could do the same but the operational story is messier.
- **Firebase Auth over Clerk/Auth0:** GCP credits cover it, and the Google sign-in flow can request Gmail scopes upfront — collapses what used to be a two-step "sign up, then connect Gmail" flow into one.
- **Gemini on Vertex AI (not Claude):** one provider for generation, judging, and embeddings (`gemini-embedding-001`, 1024-d) — GCP credits cover it, native structured output (`responseJsonSchema`) replaces brittle regex JSON parsing, and model tiering (flash for cheap judging/extraction, pro for quality-critical draft generation) is a per-call choice. The old Anthropic/Voyage path is gone (`api/_lib/llm.ts`, formerly `anthropic.ts`).
- **Cloud Tasks over Inngest/Trigger.dev:** GCP-native, free under the credit, no extra vendor.

## What's deliberately not in here

- **No GraphQL.** REST is fine.
- **No ORM.** Direct Mongo driver via the `forUser()` wrapper. The schemas in `shared/schemas.ts` are TypeScript types only; no runtime validation. Add Zod later if you want.
- **No frontend state library** (Redux/Zustand). Pages talk to `/api/data` via the `db` shim. Cache invalidation is "refetch on focus" + manual.
- **No multi-tenancy beyond per-user.** Each user is their own tenant; there's no concept of an org with shared missions.
