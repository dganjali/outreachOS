# OutreachOS — Architecture

This is the system-design companion to [README.md](README.md). README covers setup and "what does each agent do"; this doc covers **how the whole thing fits together**, **where each piece runs**, and **the proposed discovery layer that replaces Apollo without adding work for the user**.

---

## 1. What we're building

An agent-driven cold outreach platform. The user describes a mission in plain English ("find me hackathon sponsors for an event with 1,400 attendees in Toronto"); the system finds matching organizations, finds the right humans inside those organizations, drafts personalized outreach grounded in real evidence, and sends through the user's own Gmail.

**Design principles:**

- **Vendor-neutral by default.** The only paid dependencies are Anthropic (LLM) and Supabase (DB+auth+storage, free tier sufficient at low volume). Apollo is optional.
- **Sender uses their own Gmail.** No third-party send provider, no shared sending IP, no deliverability blast radius. Each user's deliverability is tied to their own domain reputation.
- **The user does the minimum.** One mission description in, full pipeline out. No CSV uploads required, no verification step, no "review these candidates first."
- **Honest about confidence.** Every contact carries a confidence tag (`verified` / `pattern` / `inferred`). Low-confidence contacts don't block sequences from being drafted, but the user can see what's load-bearing.

---

## 2. Tech stack

| Layer | Tech | Why |
|---|---|---|
| **Frontend** | React 18 + TypeScript + Vite + React Router | Standard SPA, fast HMR, small bundle. Vite output is static — deploys anywhere. |
| **State** | React Context (auth, toast) + per-page local state | No global store needed. Server state is the source of truth, fetched per page. |
| **Auth** | Supabase Auth (email/password + email confirmation) | Free, RLS-aware, JWT in browser, no separate auth service. |
| **Database** | Supabase Postgres + Row-Level Security | One database, every table RLS-scoped to `auth.uid()`. Service-role bypass for cron + agent endpoints. |
| **Storage** | Supabase Storage (`profile-assets` bucket) | Private bucket, per-user folder policies (`{user_id}/...`). Used for resume + portfolio uploads. |
| **Server** | Vercel serverless functions (Node) | Pay-per-invoke, no idle servers, Cron built in. Per-function 60s `maxDuration` is the main constraint. |
| **LLM** | Anthropic SDK — Claude Sonnet by default, Haiku for cheap calls | Tool-use loop (`web_search_20250305` server tool) handles all research. Retry/backoff wrapper for 5xx/529 in [api/_lib/anthropic.ts](api/_lib/anthropic.ts). |
| **Email send** | Gmail API via OAuth 2.0 | User connects their own Gmail; we store an encrypted refresh token and refresh access tokens as needed. |
| **PDF parsing** | `pdf-parse` (Node, no native deps) | For resume upload + structured extraction. Imported via the `lib/pdf-parse.js` inner path to dodge the self-test. |
| **Cron** | Vercel Cron | Currently `*/10 * * * *` for Gmail reply polling. Will add `* * * * *` for the discovery worker. |
| **Optional research** | Apollo.io API | High-quality firmographics + verified emails. Optional. Default codepath is web_search-only. |

**What we deliberately don't use:**

- No Redis / no separate cache. Postgres is the cache.
- No job queue service (Inngest / Trigger.dev / SQS). Postgres + Vercel Cron is the queue.
- No WebSocket server. Supabase Realtime channels handle push.
- No CDN-side compute. Vercel's edge is fine for the static frontend.

---

## 3. Hosting topology

```
                         ┌─────────────────────────────────────────┐
                         │ Vercel (frontend + serverless functions)│
                         │                                         │
   user's browser ──────▶│  ┌──────────────────────────┐           │
                         │  │ Static SPA (dist/)       │           │
                         │  └──────────────────────────┘           │
                         │  ┌──────────────────────────┐           │
                         │  │ api/* serverless funcs   │ ◀───┐     │
                         │  │  - agents/*              │     │     │
                         │  │  - integrations/gmail/*  │     │     │
                         │  │  - cron/*  (auth-gated)  │     │     │
                         │  └──────────────────────────┘     │     │
                         └─────────┬──────────────────┬──────┘     │
                                   │                  │            │
                          ┌────────▼─────┐   ┌────────▼─────┐  Vercel Cron
                          │  Supabase    │   │  Anthropic   │  every 10min:
                          │              │   │              │  /api/cron/
                          │  Postgres    │   │  Claude API  │  poll-gmail
                          │  Auth        │   │  web_search  │
                          │  Storage     │   │              │  (planned)
                          │  Realtime    │   └──────────────┘  every 1min:
                          └────────┬─────┘                     /api/cron/
                                   │                           run-discovery
                                   │
                          ┌────────▼──────────┐
                          │  Google APIs      │
                          │  (Gmail send +    │
                          │   message poll)   │
                          └───────────────────┘
```

**Network paths:**

- **Browser → Vercel SPA**: static asset fetch, cached at the edge.
- **Browser → Vercel `/api/*`**: authenticated by `Authorization: Bearer <supabase_jwt>` header; verified server-side via `supabase.auth.getUser(token)` ([api/_lib/auth.ts](api/_lib/auth.ts)).
- **Browser ↔ Supabase**: Realtime via WebSocket for push updates (new contacts/targets as discovery completes); REST/RPC for direct table reads (RLS-gated).
- **Vercel → Supabase**: service-role key bypasses RLS for cron + agent writes that need to span users (e.g. encrypted token storage).
- **Vercel → Anthropic**: every agent endpoint, with retry/backoff. The `web_search_20250305` tool runs server-side at Anthropic — outbound fetches don't originate from our IP.
- **Vercel → Google**: only the user-scoped Gmail API. We exchange the stored refresh token for an access token per request, never expose tokens to the browser.

**The 60-second wall:**

Vercel serverless functions hard-cap at 60s on hobby/pro plans. Every long-running operation must either fit in that budget OR run as a job processed by cron in N small steps. The proposed discovery layer is built around this constraint.

---

## 4. Request lifecycle (existing flow)

A user creates a mission and clicks **"Run full pipeline"**. Here's what happens today:

```
[Browser]                        [Vercel /api/agents/*]                  [Supabase]                [Anthropic]
   │                                       │                                  │                          │
   │  POST /api/agents/target              │                                  │                          │
   │  Bearer <jwt> + {mission_id}          │                                  │                          │
   ├──────────────────────────────────────▶│                                  │                          │
   │                                       │  verify JWT, load mission        │                          │
   │                                       ├─────────────────────────────────▶│                          │
   │                                       │  rate-limit check (agent_runs)   │                          │
   │                                       ├─────────────────────────────────▶│                          │
   │                                       │  insert agent_runs (running)     │                          │
   │                                       ├─────────────────────────────────▶│                          │
   │                                       │  LLM call (or Apollo + LLM)      │                          │
   │                                       ├─────────────────────────────────────────────────────────────▶│
   │                                       │  insert targets[] + complete run │                          │
   │                                       ├─────────────────────────────────▶│                          │
   │  200 { targets, run_id }              │                                  │                          │
   │◀──────────────────────────────────────│                                  │                          │
   │                                                                                                     │
   │  for each top-5 target:                                                                             │
   │    POST /api/agents/evidence  →  evidence_packs row                                                 │
   │    POST /api/agents/contacts  →  contacts[] rows                                                    │
   │    for each contact:                                                                                │
   │      POST /api/agents/sequence  →  email_sequences row                                              │
```

That client-side fan-out is the bottleneck Apollo is masking — Apollo answers in <2s so the pipeline stays under the timeout per call. **Without Apollo, web_search adds 15–40s per target**, which means batch contact discovery for 5 targets × 3 contacts each pushes past 60s easily. The discovery layer below moves that work off the request path.

---

## 5. Data model

Concept-level (not exhaustive — see the migrations for full schema):

**Identity & profile**
- `auth.users` (Supabase managed)
- `profiles` — name, role, bio, proof_points, metrics, writing_tone, linkedin_url, onboarding state
- `profile_versions` — immutable snapshots of `profiles`, written on save with coalescing (>10min between snapshots)
- `profile_assets` — uploaded resumes / portfolio PDFs, stored in `profile-assets` Storage bucket

**Outreach domain**
- `missions` — one outreach project: goal, target_description, mode (`sponsorship|bd|internship|recruiting|sales`), archived_at
- `targets` — organizations: `mission_id`, company_name, domain, fit_reason, why_now, source (`apollo|web_search`)
- `contacts` — humans at targets: `target_id`, name, role, email, source, email_status (`verified|guess|null`)
- `evidence_packs` — sourced bullets per target: `[{fact, source_url, source_title, recency}]`
- `email_sequences` — drafted 3-touch sequence: initial subject/body + followups + `profile_version_id` + `profile_refs` (which sender fields the LLM cited)

**Send & reply**
- `user_integrations` — Gmail OAuth refresh token (AES-256-GCM encrypted), provider account email
- `sent_messages` — one row per touch sent or drafted; carries `profile_version_id` + `profile_refs` copied from the parent sequence at send time
- `replies` — Gmail polled replies + classification (interested / not_now / etc.) + suggested response

**Agent observability**
- `agent_runs` — every LLM call: agent_type, status, input, output, error, started/completed timestamps. Drives the rate limit (5/min, 50/day per user).

**Discovery (proposed — see §6)**
- `discovery_jobs` — queued background work
- `domain_patterns` — cached email patterns per domain
- `email_verifications` — short-TTL DNS MX cache

**Outcomes view**
- `profile_version_outcomes` — view: per profile version, `sent_count` / `reply_count` / `reply_rate`. Inherits RLS from underlying tables.

**RLS pattern across the board:**
Every user-scoped table has policies: `select using (auth.uid() = user_id)`, same for insert/update/delete. Joined tables (contacts, sequences) check via `exists (select 1 from missions m where m.id = … and m.user_id = auth.uid())`.

---

## 6. Discovery layer (proposed Apollo replacement)

**The problem:** Apollo gives us three things in one — firmographic org search, verified contact emails, and self-profile enrichment. It's expensive. We want to replace it without (a) adding any user-facing work and (b) breaking the existing UX.

**The shape of the solution:** push discovery into an async job queue, run an autonomous Claude tool-use loop against the open web, cache aggressively (especially email patterns per domain), and stream results back into the UI via Supabase Realtime so it *feels* synchronous even though it isn't.

### 6.1 Layered design

```
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 4 — UI                                                     │
│   MissionPage status pill ("Discovery: 4 of 8 contacts")         │
│   Realtime subscriptions on targets + contacts tables            │
│   Confidence badge per contact (verified / pattern / inferred)   │
└────────────────────────┬─────────────────────────────────────────┘
                         │ inserts job rows
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 3 — Queue                                                  │
│   discovery_jobs table  (queued → running → done|failed)         │
│   Vercel Cron `* * * * *`  →  /api/cron/run-discovery             │
│   Claims N jobs with FOR UPDATE SKIP LOCKED                      │
│   Runs in parallel, each ≤60s, writes back to targets/contacts   │
└────────────────────────┬─────────────────────────────────────────┘
                         │ invokes
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 2 — Discovery Agent (tool-using Claude loop)               │
│   api/_lib/discovery/agent.ts                                    │
│   - mode-templated system prompt                                 │
│   - mode-templated toolbox                                       │
│   - 6-step budget per discovery                                  │
└────────────────────────┬─────────────────────────────────────────┘
                         │ uses
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│ LAYER 1 — Tools (the primitives, mode-agnostic)                  │
│   search_web         Anthropic web_search_20250305 wrapper       │
│   fetch_url          GET + Readability extract → markdown        │
│   extract_contacts   regex + schema.org Person → structured      │
│   github_lookup      public GitHub API (no auth, 60/hr fine)     │
│   infer_pattern      domain_patterns cache → Hunter → web fallbk │
│   predict_email      pure: (name, domain, pattern) → candidates  │
│   verify_mx          DNS MX lookup                               │
└──────────────────────────────────────────────────────────────────┘
```

### 6.2 Layer 1 — Tool primitives

A small toolbox under `api/_lib/discovery/tools/`. Each tool is a pure async function with strict typed input/output. The agent invokes them via Anthropic's tool-use loop.

| Tool | I/O contract | Cost | Notes |
|---|---|---|---|
| `search_web(query)` | string → `[{url, title, snippet}]` | 1 Anthropic call | Wraps `web_search_20250305` server tool |
| `fetch_url(url)` | url → `{title, markdown, links}` | Free | UA: `OutreachOSBot/1.0 (+https://outreachos.example/bot)`. Respect robots.txt. 5s timeout. |
| `extract_contacts(text)` | markdown → `[{name?, email?, role?, links?}]` | Free | Mailto: links, `mailto:` decoded, schema.org `Person` blocks, simple email regex with domain validation |
| `github_lookup(query)` | `{name?, company?, username?}` → `[{login, email?, bio, blog, company}]` | Free (60/hr unauth, 5000/hr with token) | Email from `users/{u}` is opt-in by the user; fallback to commit emails via `users/{u}/events` |
| `infer_pattern(domain)` | domain → `{pattern, confidence, source}` | Cached + Hunter (25/mo free) | Patterns: `{first}.{last}@`, `{f}{last}@`, `{first}@`, etc. |
| `predict_email(name, domain, pattern)` | `(name, domain, pattern)` → candidate email | Free | Pure function |
| `verify_mx(email)` | email → `{mx_ok: bool, ttl: number}` | Free DNS | Cached 24h in `email_verifications` |

**Why no SMTP probe.** SMTP `RCPT TO` probing gets your originating IP blacklisted by major providers within hours. The deliverability win isn't worth the operational pain. DNS MX is enough to filter dead domains, and the user's own Gmail will catch bounces on first send.

### 6.3 Layer 2 — Discovery agent

`api/_lib/discovery/agent.ts` exports one function:

```ts
discoverContact({
  company_name: string,
  domain: string | null,
  role_hint: string,        // e.g. "VP Marketing" or "engineering lead"
  mode: MissionMode,
}): Promise<DiscoveredContact>
```

Internally it's a Claude tool-use loop:

1. **System prompt** templated by mode (see `api/_lib/discovery/modes.ts` below)
2. **Tools** handed to Claude are mode-filtered (see toolbox table below)
3. **Loop budget**: max 6 tool invocations, then forced final answer
4. **Output schema** (`tool_choice: 'tool'` with a `record_contact` tool, no free-form): `{ name, role, email | null, confidence, source_url, evidence }`

The same agent handles `discoverTargets({ mission_description, mode, count })` by changing the prompt — it returns `[{ company_name, domain, fit_reason, why_now }]`.

**Mode → toolbox mapping** (`api/_lib/discovery/modes.ts`):

| Mode | Base tools | Mode-specific additions |
|---|---|---|
| `sponsorship` | search + fetch + extract + pattern + verify | conference partner pages, /sponsors pages |
| `bd` | base | /partners pages, Crunchbase free, press mentions |
| `internship` | base | github_lookup, alumni directory search, HN "who's hiring" |
| `recruiting` | base | github_lookup, speaker pages, Substack /about |
| `sales` | base | podcast guest search, press mentions, /team pages |

Mode-specific tools are just opinionated wrappers around `search_web` with templated queries — e.g. `partners_page(domain) := fetch_url(domain + '/partners')` with a fallback to `search_web(domain + ' partners')`.

### 6.4 Layer 3 — Job queue

**Why queues:** A single Apollo-free discovery of one contact costs 15–40s (search, fetch a couple of URLs, pattern-infer if needed). For a pipeline run on 5 targets × 3 contacts each, that's 4–10 minutes — far past the 60s function limit. Queue + cron is the simplest way to break that into 60s slices without paying for Inngest or running a worker process.

**Schema (proposed migration `009_discovery_jobs.sql`):**

```sql
create table public.discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mission_id uuid not null references public.missions(id) on delete cascade,
  target_id uuid references public.targets(id) on delete cascade,
  kind text not null check (kind in ('find_targets', 'find_contact')),
  input jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued','running','done','failed','cancelled')),
  attempts int not null default 0,
  output jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index discovery_jobs_claim_idx
  on public.discovery_jobs(status, created_at)
  where status = 'queued';
create index discovery_jobs_mission_idx
  on public.discovery_jobs(mission_id, status);

alter table public.discovery_jobs enable row level security;
-- select policy: own rows
-- insert/update/delete: cron uses service role; no user write needed
```

**Cron worker (`api/cron/run-discovery.ts`):**

Runs every minute. Each invocation:

```ts
1. Claim batch:
   update discovery_jobs
   set status='running', attempts=attempts+1, started_at=now()
   where id in (
     select id from discovery_jobs
     where status='queued'
     order by created_at
     for update skip locked
     limit 10
   )
   returning *;

2. Promise.allSettled the batch (each job has its own 50s soft budget).

3. For each completed job:
   - if find_targets: insert into targets, then queue find_contact jobs per target
   - if find_contact: insert into contacts
   - mark job done|failed, write output|error

4. Retry policy:
   - attempts < 3 and not a hard validation error → re-queue with backoff
   - else → failed, error message visible in UI
```

**Concurrency:** 10 jobs/tick × 60 ticks/hour = 600 jobs/hour ceiling per Vercel function. That's well above expected volume on free Anthropic + Hunter tiers, and we get linear scaling by raising the batch size if we ever hit it.

**FOR UPDATE SKIP LOCKED** is critical — it makes the queue safe under concurrent cron runs (in case Vercel ever overlaps invocations).

### 6.5 Layer 4 — UI feedback (no new screens)

The existing **MissionPage** and contact tables stay. We add:

- **Status pill** in the mission header, derived from a server view `mission_discovery_progress`:
  - `select mission_id, count(*) filter (where status='done') as done, count(*) as total from discovery_jobs group by mission_id`
- **Supabase Realtime channels** on `targets` and `contacts` filtered by `mission_id` — rows appear in the table as they're written, no polling.
- **Confidence badge** on each contact row: `verified` (DNS MX + pattern match) / `pattern` (pattern-cached, MX-ok) / `inferred` (heuristic only, no verification). Informational only — never blocks sequence drafting.

**"Run full pipeline" behavior change:**

Today the button orchestrates client-side, calling `/api/agents/target` → for each target call `/api/agents/evidence` etc. **After the discovery layer ships**, the button just inserts a `find_targets` job row and shows the pill. The cron does everything else. The user can navigate away and come back; results are durable in the DB.

### 6.6 Pattern + verify spine (the deliverability backbone)

This is the unsung hero of the architecture. It's small, cheap, and replaces 80% of Apollo's email value.

**`domain_patterns` table (proposed migration `010_domain_patterns.sql`):**

```sql
create table public.domain_patterns (
  domain text primary key,
  pattern text not null,           -- e.g. '{first}.{last}@'
  confidence real not null,        -- 0.0 - 1.0
  source text not null
    check (source in ('apollo','hunter','observed','web_search','heuristic')),
  learned_from_email text,         -- the email we observed this from, if any
  learned_at timestamptz not null default now(),
  observation_count int not null default 1
);
```

This is **global**, not per-user — the pattern for `acme.com` is the same regardless of who's reaching out. That's a deliberate choice: it lets the cache warm fastest across the whole user base. RLS is permissive on reads (everyone benefits), writes are service-role only.

**Confidence ladder** (used to populate the contact's `email_status`):

| Pattern source | Email after pattern applied | Then MX-verify → | Tag |
|---|---|---|---|
| `apollo` (still in legacy data) | … | mx_ok | `verified` |
| `hunter` (high-confidence) | … | mx_ok | `pattern` |
| `observed` (we've seen an email at this domain in the past) | … | mx_ok | `pattern` |
| `web_search` (extracted from public mention) | … | mx_ok | `inferred` |
| `heuristic` (`{first}.{last}@` as default) | … | mx_ok | `inferred` |
| anything | … | mx_fail | filtered, no contact row |

**Bootstrap strategy:**

- Every Apollo-sourced contact (if `APOLLO_API_KEY` is still set) **observes** its pattern into `domain_patterns`. Apollo's value compounds even after we churn off it.
- Every successful Gmail send + non-bounce update observation count.
- Every bounce or `unsubscribe` reply downgrades the pattern's confidence.

This means the longer the system runs, the less it needs new pattern inference. Steady state: most contacts at known domains get a `pattern`-tagged email instantly with a single DNS MX call.

### 6.7 Graceful degradation (the "no work for user" promise)

Where discovery can't produce a usable contact:

1. Try a company-general fallback: `info@`, `hello@`, `contact@`, gated by DNS MX. If any work, return that with `confidence: 'inferred'`, name = "Team @ {company}".
2. If no general email works either, **the contact is not surfaced**. The discovery job completes with `output.found = false`, and the UI shows "found 6 of 8 requested" rather than presenting a dead lead.

The user is **never** asked to verify an email, fill in a missing one, or confirm a pattern guess. If the architecture can't deliver autonomously, the result is fewer contacts — never broken contacts.

---

## 7. Costs & quotas

Steady-state per active user assumptions: 5 missions / month, 5 targets / mission, 3 contacts / target = 75 contacts / month / user.

| Component | Free quota | Cost above free |
|---|---|---|
| **Vercel hobby** | 100GB-hr functions / month | Free for our shape (each call < 60s, low concurrency) |
| **Supabase free** | 500MB DB, 1GB Storage, 2GB egress, 50k MAU | $25/mo Pro at scale, irrelevant short-term |
| **Anthropic** | Pay-per-token | ~$0.01–0.03 per contact at Sonnet (sequence drafting), <$0.005 with Haiku (discovery). Budget: **$1–3 / user / month** |
| **Hunter.io free** | 25 lookups / month | Pattern inference fallback only — most calls are cache hits |
| **GitHub API** | 60/hr unauth, 5000/hr with PAT | Free; add a `GITHUB_TOKEN` env var when traffic warrants |
| **Google APIs (Gmail)** | 1B quota units/day, ~1M sends/day | User's own quota — not ours |
| **DNS MX lookups** | Unlimited via Node `dns` | Free |
| **Apollo (optional)** | $0 unset, $49+ when enabled | User chooses |

**Anthropic is the dominant cost.** A discovery loop typically runs 3–5 tool calls (mostly free or cached) and 2–4 LLM messages. With Haiku at $1/M input + $5/M output tokens, average ~3k in + ~1k out = $0.008/discovery. 75 contacts = $0.60/user/month before any sequence drafting. Add sequence drafting at Sonnet (~$0.02/sequence × 75 = $1.50) and you're at ~$2.10/user/month. Pricing well within sustainable margins.

---

## 8. Migration path from Apollo

We don't rip out Apollo in one PR. Phased rollout:

**Phase D1 — Pattern + verify spine (1–2 days)**
Ship `domain_patterns` + `email_verifications` + the `infer_pattern` / `verify_mx` tools. Wire them into existing [api/agents/contacts.ts](api/agents/contacts.ts) so **every contact discovered via Apollo or web_search updates the pattern cache**. Immediate value, zero risk to existing flow.

**Phase D2 — Sync discovery agent for single contact (2–3 days)**
Build `api/_lib/discovery/agent.ts` and tools. New endpoint `api/agents/discover-contact.ts` (sync, 60s budget) replaces the contact-discovery web_search fallback. When `APOLLO_API_KEY` is unset, this is the new default path. Apollo still wins when key is present.

**Phase D3 — Job queue + async batches (3–4 days)**
Add `discovery_jobs` + cron worker. Convert the **"Run full pipeline"** button to enqueue work instead of orchestrating client-side. Realtime channel pushes results back. This is the phase that makes Apollo-free batch discovery viable.

**Phase D4 — Mode toolboxes (1–2 days)**
Add `api/_lib/discovery/modes.ts` mode → toolbox config. Per-mode prompt templates. Polish.

**Phase D5 — Apollo demotion (decision point, post-D4)**
With everything above shipped, Apollo becomes a feature flag for power users who'll pay for guaranteed-verified emails. The default and documented path is free.

**Total: ~8–12 dev days** to fully replace Apollo while preserving the existing UX exactly.

---

## 9. Operational notes

**Rate limits the user sees:**
- 5 agent runs / minute / user, 50 / day. Enforced in [api/_lib/runs.ts](api/_lib/runs.ts) via a count over `agent_runs`. The discovery cron is service-role and bypasses this — it doesn't write to `agent_runs` per tool call.

**Rate limits we impose on ourselves:**
- One concurrent discovery job per `mission_id` (DB-enforced via a partial unique index). Prevents accidental double-firing if the user spam-clicks "Run pipeline".
- 10 jobs / cron tick globally per Vercel function. Adjustable.

**Failure handling:**
- Discovery jobs retry up to 3 times with exponential backoff (1m, 5m, 15m).
- After 3 failures, status flips to `failed` with the error message; visible in the mission status pill as "2 contacts failed — retry?". Click retry → status flips back to `queued`.

**Monitoring:**
- Every agent run is logged in `agent_runs` with input/output/error. Query that table for any incident triage.
- Vercel logs capture all unhandled rejections. `vercel logs --follow` during a smoke test surfaces them.
- Supabase logs handle DB-level failures (RLS denials, constraint violations).

**Cron schedule (`vercel.json`):**

```json
{
  "crons": [
    { "path": "/api/cron/poll-gmail",     "schedule": "*/10 * * * *" },
    { "path": "/api/cron/run-discovery",  "schedule": "* * * * *"   }
  ]
}
```

Each cron endpoint authenticates by `Authorization: Bearer ${CRON_SECRET}` (Vercel injects this when invoking) and fails closed if absent.

**Data retention:**
- `agent_runs`: keep forever (cheap, useful for outcome attribution per profile_version)
- `discovery_jobs`: hard-delete jobs older than 30 days (in a daily cron, not yet implemented)
- `email_verifications`: TTL 7 days, refreshed lazily on contact-write
- `domain_patterns`: keep forever; downgrade confidence on bounces rather than delete

---

## 10. What's out of scope (for now)

- **No background follow-up auto-send.** All sends are user-initiated from the mission page; the cron only *polls* Gmail for replies, never *sends*.
- **No suppression list / per-day send caps.** The user's own Gmail rate limits handle this naturally.
- **No Outlook OAuth.** Gmail only. Outlook is on the deferred list.
- **No team workspaces.** Single-user accounts. RLS assumes one user per row across all tables.
- **No payment / billing.** Free product on whoever's Anthropic + Supabase keys. Will revisit if usage warrants.

---

## 11. File map

```
api/
  agents/
    target.ts          ─ org discovery (Apollo or web_search)
    contacts.ts        ─ contact discovery (Apollo or web_search)
    evidence.ts        ─ evidence pack per target
    sequence.ts        ─ 3-touch email draft
    reply.ts           ─ classify + suggest response to a reply
    enrich-profile.ts  ─ self-profile from LinkedIn URL
    coach.ts           ─ Me-section field-level rewrites
    parse-resume.ts    ─ PDF → structured profile fields
  cron/
    poll-gmail.ts      ─ replies poller (existing)
    run-discovery.ts   ─ job queue worker (PROPOSED)
  gmail/
    send.ts            ─ draft or send a touch
  integrations/gmail/
    start.ts           ─ OAuth init
    callback.ts        ─ OAuth callback
    status.ts          ─ connection state
    disconnect.ts      ─ revoke token
  _lib/
    anthropic.ts       ─ client + retry wrapper + web_search constant
    apollo.ts          ─ optional Apollo adapter
    auth.ts            ─ JWT verify + method guards
    crypto.ts          ─ AES-256-GCM for refresh tokens
    env.ts             ─ centralized env var access
    gmail.ts           ─ Gmail API helpers (RFC2822 build, send, draft)
    prompts.ts         ─ all agent system prompts
    runs.ts            ─ agent_runs CRUD + rate limit
    supabase.ts        ─ admin/anon clients
    discovery/         ─ PROPOSED: web-agent replacement for Apollo
      agent.ts         ─   tool-use loop
      modes.ts         ─   mode → toolbox/prompt config
      tools/
        search.ts
        fetch.ts
        extract.ts
        github.ts
        pattern.ts
        verify.ts

shared/
  types.ts             ─ shared between frontend and backend

src/
  pages/               ─ React Router routes
  components/          ─ reusable UI
  context/             ─ auth + toast providers
  lib/
    api.ts             ─ typed fetch wrappers
    profileSnapshot.ts ─ Me-section snapshot/diff helpers
    profileAssets.ts   ─ Me-section uploads
  index.css            ─ design tokens + every page's styles

supabase/
  schema.sql           ─ base tables + RLS
  migrations/
    002_agent_layer.sql
    003_gmail_integration.sql
    004_cleanup.sql
    004_apollo_personalization.sql
    005_profile_versions.sql
    006_coach_agent.sql
    007_profile_assets.sql
    008_profile_outcomes.sql
    009_discovery_jobs.sql        ─ PROPOSED
    010_domain_patterns.sql       ─ PROPOSED
```
