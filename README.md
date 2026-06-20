# OutreachOS

Agent-powered cold outreach. Runs on **MongoDB Atlas + Firebase Auth + Google Cloud Run**, with Atlas Vector Search for retrieval-grounded email generation. Optional **Serper** (LinkedIn-scoped discovery) and **emailfinder.dev** (SMTP-verified email resolution) integrations upgrade contact discovery.

## What it does

End-to-end agent pipeline per mission:

1. **Targeting Agent** - pulls high-fit organizations via web_search, ranked by recent "why now" signals.
2. **Contact Graph Agent** - 2–4 decision-makers per target. Discovery via **Serper** (LinkedIn-scoped search, with `SERPER_API_KEY`) or web_search fallback. Emails are resolved (not guessed) via **emailfinder.dev** SMTP verification (with `EMAILFINDER_API_KEY`) or a real address scraped from the company site; unresolved contacts keep a display-only likely-email pattern, never a shipped guess.
3. **Evidence Agent** - 4–6 sourced bullets per target. Embedded with Gemini for downstream vector retrieval.
4. **Sequence Agent** - mode-aware initial email + 2 follow-ups, anchored in evidence. Retrieves your own past sequences-that-got-replies via Atlas Vector Search and feeds them in as exemplars.
5. **Profile Enrichment Agent** - reads sender LinkedIn URL → auto-fills bio, proof points, metrics, tone.

Modes: `sponsorship`, `bd`, `internship`, `recruiting`, `sales`.

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 18 + TS + Vite, served via **Firebase Hosting** (with an `/api/**` rewrite to Cloud Run) |
| Backend | Node + Express, packaged in a Docker container, deployed to **Cloud Run** |
| Auth | **Firebase Auth** (Identity Platform) - Google sign-in + email/password |
| Database | **MongoDB Atlas** on GCP (same region as Cloud Run) |
| Vector retrieval | **Atlas Vector Search** with **Gemini** embeddings (gemini-embedding-001, 1024d) |
| Object storage | **Google Cloud Storage** (resumes, portfolio PDFs) |
| Job queue | **Cloud Tasks** + Cloud Scheduler |
| Secrets | **Google Secret Manager** |
| LLM | **Google Gemini 2.5** on Vertex AI (Flash for research/extraction, Pro for drafting) |
| Email | Gmail OAuth (per-user) |

## Quick start

Full setup playbook: see **[daniel-todo.md](./daniel-todo.md)** - every command, in order.

```bash
npm install
cp .env.example .env       # fill in keys

# Provision Mongo schema (after you've got an Atlas cluster + MONGODB_URI):
npm run mongo:init

# Local API server:
npm run server:dev   # http://localhost:8080

# Local frontend:
npm run dev          # http://localhost:5173 - proxies /api/* to :8080 via Vite
```

## Layout

```
api/
  _lib/
    anthropic.ts     Claude client + JSON extraction + retry
    auth.ts          Firebase JWT verification
    crypto.ts        AES-GCM for OAuth tokens at rest
    db.ts            MongoDB client + forUser(uid) wrapper (replaces RLS)
    embeddings.ts    Voyage AI client
    env.ts           Lazy env var access
    gmail.ts         Gmail API + OAuth lifecycle
    prompts.ts       Mode-aware system prompts
    queue.ts         Cloud Tasks enqueue
    runs.ts          agent_runs lifecycle + rate limiting
    storage.ts       Google Cloud Storage helpers
  agents/            POST handlers - target, contacts, evidence, sequence,
                     reply, coach, parse-resume, enrich-profile
  data/router.ts     Generic CRUD for the frontend
  gmail/send.ts      Per-touch Gmail send/draft
  integrations/gmail/{start,callback,status,disconnect}.ts
  cron/poll-gmail.ts Cloud Scheduler → poll Gmail for replies
  tasks/worker.ts    Cloud Tasks worker (queued sends, scheduled touches)

server/
  index.ts           Express app - Cloud Run entry point

shared/
  schemas.ts         Mongo collection types + INDEX_SPEC + VECTOR_INDEX_SPEC
  types.ts           Shared TS types (frontend + backend)

scripts/
  init-mongo.ts                Creates collections + indexes + vector indexes
  migrate-from-supabase.ts     (Stub) data migration template

src/
  firebaseClient.ts  Firebase Auth SDK init
  context/AuthContext.tsx   Firebase-backed auth context
  lib/api.ts         Frontend client (attaches Firebase ID token)
  lib/db.ts          Supabase-shaped shim over /api/data - gradually delete
  pages/, components/
```

## Required env vars

See `.env.example`. Headline secrets:

- `MONGODB_URI` - Atlas connection string
- `VITE_FIREBASE_*` + `FIREBASE_PROJECT_ID` + `FIREBASE_SERVICE_ACCOUNT_JSON`
- `VOYAGE_API_KEY`
- `GCP_PROJECT_ID` + `GCS_BUCKET` + `CLOUD_TASKS_*`
- `ANTHROPIC_API_KEY`, `ENCRYPTION_KEY`, `CRON_SECRET`, `GOOGLE_CLIENT_ID/SECRET`

Optional contact-data providers (each feature is off unless its key is set):

- `SERPER_API_KEY` - Serper SERP API for person discovery (deterministic, replaces the flaky LLM web_search)
- `EMAILFINDER_API_KEY` - emailfinder.dev SMTP-verified email resolution

In prod these all come from Secret Manager (see `cloudbuild.yaml`).

## Why Atlas Vector Search?

The sequence agent does an `$vectorSearch` over your own `email_sequences` collection filtered to `status: 'replied'` - the top-3 semantic matches for the current mission's goal get fed in as exemplars. Means the LLM gets to learn from emails *you* sent that *actually got replies*, not generic best-practices.

Same vector index on `evidence_packs` and `profile_assets` is wired but not yet used at query time - see daniel-todo.md.

## What's shipped vs deferred

**Shipped:** Targeting, contacts, evidence, sequence, reply classification, profile enrichment, Gmail send/poll, resume parsing, coach agent, full pipeline orchestration.

**Deferred (now unblocked by the new stack):**
- Auto-send scheduler - Cloud Tasks + scheduled-send API endpoint
- Background job queue for long-running batches - Cloud Tasks worker
- Suppression list + per-day send caps
- Inline draft editing / regenerate-with-feedback
- Outlook (Gmail-only for v1)
