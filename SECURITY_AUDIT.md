# Security Audit — OutreachOS

**Date:** 2026-06-13
**Branch:** `claude/security-hardening-audit-pd3kbd`
**Scope:** Full application — Express API (`api/`, `server/`), React frontend
(`src/`), shared code, build/deploy config. Authenticated multi-tenant SaaS on
Cloud Run + MongoDB Atlas + Firebase Auth + GCS.

This document records (1) the hardening work performed in this branch and
(2) the remaining risks found during the audit, with severity and
recommendations.

---

## 1. Hardening performed in this branch

### 1.1 Rate limiting (requirement #1)

- **New:** `api/_lib/rate-limit.ts` — a dependency-free, in-memory per-IP
  fixed-window limiter (no new supply-chain surface; trivially auditable).
- **Global limiter:** 120 requests / minute / IP on **every** endpoint, mounted
  in `server/index.ts`. Sized above the app's own pipeline fan-out (~12 agent
  calls/min) so it never throttles legitimate orchestration.
- **Auth limiter:** **5 attempts / 15 minutes / IP** on the OAuth
  (authentication) routes — `POST /api/integrations/gmail/start` and
  `GET /api/integrations/gmail/callback`. These are the only server-exposed
  authentication-flow endpoints; primary user login/signup is delegated to
  Firebase Auth (client SDK → Firebase), which enforces its own throttling and
  never hits this server.
- `app.set('trust proxy', true)` so `req.ip` reflects the real client behind the
  Cloud Run front end. `x-powered-by` disabled.
- Returns `429` with `RateLimit-*` and `Retry-After` headers.
- **Pre-existing, retained:** `api/_lib/runs.ts` enforces a per-*user*,
  Mongo-backed cost cap on agent runs (20/min, 150/day) — global across
  instances. The new IP limiter is complementary network-layer defense.
- Tests: `api/_lib/rate-limit.test.ts`.

### 1.2 Secrets scan (requirement #2)

Result: **no hardcoded secrets found** in the working tree or git history.

- Working tree and full history scanned for API-key/token/private-key patterns
  and for ever-committed `.env` / service-account files → none.
- Server secrets are sourced from **Google Secret Manager** at deploy time
  (`cloudbuild.yaml --set-secrets`) and read via `process.env` through the
  single `api/_lib/env.ts` accessor. No literal values in code.
- Frontend reads only `VITE_FIREBASE_*` values from build-time env
  (`src/firebaseClient.ts`). The Firebase web `apiKey` is a **public** project
  identifier (not a credential) — access is gated by Firebase Auth, not by the
  key — so bundling it is expected and safe. No secret keys (Mongo, OAuth
  client secret, encryption key, provider API keys) are referenced anywhere in
  `src/`.
- `.gitignore` already excludes `.env*`, `/secrets/`, and service-account JSON.
- **New:** `.env.example` documents every required/optional variable with
  placeholder values and a server-vs-frontend (secret-vs-public) split.

### 1.3 Input sanitization & payload limits (requirement #3)

- **New:** `api/_lib/sanitize.ts` — deep write-body validator rejecting:
  - **Prototype-pollution** keys (`__proto__`, `constructor`, `prototype`) at
    any depth (the JSON-text vector, not just object literals);
  - **Stored Mongo operators / dotted paths** (`$...`, `a.b`) that would
    otherwise reach `$set`;
  - **Oversized / pathological payloads** (bounded depth, key count, and
    per-string length).
  Wired into the generic CRUD write paths (`POST`/`PATCH /api/data/:collection`)
  → `400 invalid_payload`. Tests: `api/_lib/sanitize.test.ts`.
- **Body limits:** JSON body cap reduced from 4 MB → **256 KB** (all bodies are
  small ids+text; file uploads bypass the body via signed GCS URLs). A
  `verify` hook rejects non-object/array bodies up front.
- **Malformed-payload handling:** a body-parser error handler now returns
  `400 malformed_payload` for invalid JSON and `413 payload_too_large` for
  oversize, instead of falling through to the generic `500`.
- **Baseline security headers** added (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS).
- **Timing-safe cron secret:** `requireCronSecret` now uses
  `crypto.timingSafeEqual` instead of `!==` (removes a secret-comparison timing
  side-channel).

### 1.4 Pre-existing defenses verified (left in place)

These were already implemented and were confirmed correct during the audit:

- **NoSQL operator injection** on query filters — allowlisted operators only
  (`api/data/router.ts` `sanitizeFilter`); `$where`/`$regex`/`$expr` rejected.
- **Tenant isolation** — every read/write is funneled through
  `forUser(uid).collection()` which injects `userId: uid`
  (`api/_lib/db.ts`). Client-supplied `userId` is stripped on write.
- **Storage IDOR** — signed-download/delete gated by `ownsStoragePath`
  (`users/{uid}/...` prefix, traversal/encoding-proof).
- **SSRF guard** — `api/_lib/web-scrape.ts` pins DNS, blocks private/link-local/
  metadata ranges, restricts to http(s), and re-checks on redirect.
- **Email header injection** — recipient validated by `isValidEmailAddress`
  before message assembly (`api/gmail/send.ts`).
- **OAuth token-at-rest** — refresh/access tokens AES-256-GCM encrypted
  (`api/_lib/crypto.ts`); OAuth `state` is encrypted and time-boxed (10 min).
- **Auth model** — Bearer Firebase JWTs (not cookies), so the API is not
  CSRF-exposed; the OAuth callback uses encrypted `state` as its CSRF token.

---

## 2. Remaining vulnerabilities & risks

Ordered by severity. None are known-exploitable for cross-tenant data access;
the tenant-isolation layer holds.

### MEDIUM

**M1 — Generic CRUD lets a user write arbitrary fields to their own documents.**
`POST`/`PATCH /api/data/:collection` accept any field (now shape-sanitized, but
not schema-validated). A user can directly set business-logic fields on their
own records — e.g. flip `email_sequences.status` to `approved`/`sent`, set
`onboardingCompletedAt`, write `suppressions`, or populate `embedding` — bypassing
the server workflows that normally gate those transitions. Impact is confined to
the caller's own tenant (no cross-user reach), so this is an **integrity /
business-logic** issue, not a data-disclosure one.
*Recommendation:* per-collection field allowlists (or Mongo `$jsonSchema`
validators — `shared/schemas.ts` notes validators are intentionally OFF), and
route state-machine fields (`status`, `sentAt`, …) exclusively through the
dedicated endpoints.

**M2 — Vulnerable transitive dependencies (`npm audit`: 3 high, 10 moderate).**
- `esbuild <=0.28.0` (high) — dev server request SSRF / RCE vectors. **Dev-only**
  (build tooling, `devDependencies`); not in the deployed runtime.
- `react-router <` patched (moderate) — open redirect via protocol-relative
  `//` paths. Frontend-facing; worth patching.
- `uuid`, `retry-request`, `teeny-request`, `google-gax`,
  `@google-cloud/firestore`, `firebase-admin` (moderate, transitive).
*Recommendation:* `npm audit fix`, bump `react-router-dom`, and re-pin
`firebase-admin`/`@google-cloud/*` to patched releases. Add `npm audit` (or
Dependabot) to CI.

### LOW

**L1 — Unbounded query result set.** `POST /api/data/:collection/query` calls
`find()` with no DB-side limit, then slices in memory; the `limit` param only
shrinks the returned array. A tenant with very many documents can force large
reads. Self-scoped, so low impact. *Recommendation:* push `limit` (with a hard
server cap) and `sort` into the Mongo query.

**L2 — Error responses echo internal messages.** Several handlers and the
top-level error middleware return raw `err.message` in `detail`, which can leak
internal/driver details. *Recommendation:* return generic messages to clients in
production; log specifics server-side.

**L3 — Per-instance rate-limit store.** The IP limiter is in-memory, so on N
Cloud Run instances the effective auth cap is `5 × N` per 15 min. Adequate as
defense-in-depth but not a hard global cap. *Recommendation:* back the limiter
with a shared store (Memorystore/Redis) if a strict global ceiling is required;
the `consume()` interface is store-agnostic to localize that swap.

**L4 — OAuth `redirect_uri` derived from client-supplied `origin`.**
`gmail/start` builds the OAuth `redirect_uri` from `req.body.origin`. Google
rejects any `redirect_uri` not in the registered allowlist, so this is not an
open redirect today, but it is unvalidated input feeding an auth flow.
*Recommendation:* validate `origin` against an explicit allowlist of known app
origins.

### INFORMATIONAL

- **No CORS middleware** — acceptable: API is same-origin and Bearer-token
  authenticated (browsers don't auto-attach `Authorization` cross-site).
- **No Content-Security-Policy** — left to the CDN/LB layer where script origins
  (Firebase, Three.js) are known; a strict CSP in Express risks breaking the SPA.
- **Outreach-volume abuse** — Gmail send is gated by the per-user agent limiter
  but there is no separate daily send cap; consider one to bound spam/abuse and
  protect sender reputation.

---

## 3. Verification

- `npm run server:typecheck` — clean.
- `npm run server:build` — clean.
- `npm test` — 75 pass / 0 fail (2 pre-existing env-gated skips), including the
  new rate-limit and sanitize suites.
