# OutreachOS

Agent-powered cold outreach. Vendor-neutral by default — just an LLM API key + Supabase + Gmail. Optional **Apollo.io** integration upgrades target hunting, contact discovery, and sender personalization when you add a single env var.

## What it does

End-to-end agent pipeline per mission:

1. **Targeting Agent** — pulls high-fit organizations. With `APOLLO_API_KEY`, it derives Apollo filters from the mission, fetches a candidate pool, and re-ranks with web_search "why now" signals. Without Apollo, it runs pure web_search.
2. **Contact Graph Agent** — finds 2–4 decision-makers per target. With Apollo, contacts come back with verified emails + LinkedIn URLs + seniority. Without Apollo, it falls back to web_search and likely-email patterns.
3. **Evidence Agent** — builds a 4–6 bullet sourced evidence pack per target.
4. **Sequence Agent** — drafts a mode-aware initial email + 2 follow-ups, anchored in evidence and the sender's enriched profile.
5. **Profile Enrichment Agent** — reads the sender's LinkedIn URL during onboarding (or on demand from the Profile page) and auto-fills bio, proof points, achievements, metrics, and tone for personalization.

Click **Run full pipeline** on a mission to fire steps 1–4 sequentially for the top 5 targets.

Modes: `sponsorship`, `bd`, `internship`, `recruiting`, `sales` — each shifts the system prompt to surface the right angles.

## Stack

- **Frontend**: React 18 + TypeScript + Vite, Supabase auth + Postgres (RLS).
- **Backend**: Vercel serverless functions (`api/`), Anthropic SDK, Supabase service-role client.
- **Research**: Claude's built-in `web_search_20250305` server tool. No third-party scrapers.

## Local dev

```bash
npm install
cp .env.example .env.local   # fill in keys
npm run dev                   # frontend on :5173
vercel dev                    # frontend + /api/* serverless on :3000
```

`vercel dev` is required to run the agent endpoints locally.

## Required env vars

| Var | Where | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | frontend | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | frontend | Supabase anon key |
| `SUPABASE_URL` | server | same URL, server-side |
| `SUPABASE_SERVICE_ROLE_KEY` | server | bypasses RLS — never expose |
| `ANTHROPIC_API_KEY` | server | Claude API key |
| `ANTHROPIC_MODEL` | server (optional) | defaults to `claude-sonnet-4-5` |
| `ENCRYPTION_KEY` | server | random string; encrypts OAuth refresh tokens at rest |
| `GOOGLE_CLIENT_ID` | server | Gmail OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | server | Gmail OAuth client secret |
| `CRON_SECRET` | server | shared secret Vercel Cron sends as Bearer; protects `/api/cron/*` |
| `APOLLO_API_KEY` | server (optional) | Apollo.io API key. When set, target search and contact discovery use Apollo first (verified emails, firmographics) and fall back to web search if Apollo returns nothing. |

## Database

Run in the Supabase SQL editor in this order:

1. `supabase/schema.sql` — base tables + RLS
2. `supabase/migrations/002_agent_layer.sql` — mode, scoring, evidence_packs, email_sequences, agent_runs
3. `supabase/migrations/003_gmail_integration.sql` — user_integrations, sent_messages, replies extensions
4. `supabase/migrations/004_cleanup.sql` — drops dead `emails` table, tightens replies RLS, adds `missions.archived_at`

## Google Cloud setup (Gmail OAuth)

1. Create a project at https://console.cloud.google.com/
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External, add your email as a test user. Scopes (added on the consent screen):
   - `.../auth/gmail.send`
   - `.../auth/gmail.modify`
   - `.../auth/gmail.readonly`
   - `.../auth/userinfo.email`
4. **Credentials → Create credentials → OAuth client ID** → Web application.
   - Authorized redirect URIs:
     - `http://localhost:3000/api/integrations/gmail/callback` (for `vercel dev`)
     - `https://your-domain.vercel.app/api/integrations/gmail/callback`
5. Copy the Client ID + Secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars.
6. While the app is in "Testing" mode, only listed test users can connect. Submit for verification before public launch (only required if you scale past ~100 users).

## Deploy (Vercel)

- Framework Preset: **Other** (so the `api/` functions deploy alongside the SPA).
- Build Command: `npm run build`
- Output Directory: `dist`
- Set all env vars above in Project Settings → Environment Variables.
- `vercel.json` already configures SPA routing + `maxDuration: 60` for agent endpoints.

## Architecture

```
api/
  _lib/
    anthropic.ts      Anthropic client + JSON extraction
    apollo.ts         Optional Apollo.io client (active when APOLLO_API_KEY is set)
    supabase.ts       Service-role client
    auth.ts           JWT verification
    prompts.ts        Mode-aware system prompts + angles
    runs.ts           agent_runs lifecycle helpers
    env.ts            Lazy env var access
  agents/
    target.ts         POST /api/agents/target          (Apollo + web_search hybrid)
    contacts.ts      POST /api/agents/contacts        (Apollo + web_search hybrid)
    evidence.ts      POST /api/agents/evidence
    sequence.ts      POST /api/agents/sequence
    enrich-profile.ts POST /api/agents/enrich-profile  (LinkedIn → sender bio/proof/tone)

src/
  lib/api.ts          Frontend client (auto-attaches Supabase JWT)
  pages/              Dashboard, Missions, MissionPage, Profile, etc.
  components/
    CsvImport.tsx     Bring-your-own-list (Apollo CSV escape hatch)
```

## M1 — Send & Track (shipped)

- Gmail OAuth (`Settings → Connect Gmail`).
- Per-touch send buttons on every drafted sequence: "Save as Gmail draft" or "Send now."
- `sent_messages` records each touch with Gmail message + thread IDs.
- Vercel Cron (`*/10 * * * *`) polls connected mailboxes for replies → writes to `replies`.
- Reply Router agent classifies replies (interested / not_now / wrong_person / etc.) and drafts a suggested response.
- `Inbox` page lists replies, classifications, and lets you re-classify on demand.

## Apollo + LinkedIn personalization (shipped)

- `APOLLO_API_KEY` toggles Apollo for both targeting (`/mixed_companies/search`) and contact discovery (`/mixed_people/search`). Falls back to web_search when unset, when Apollo errors, or when filters return nothing.
- Onboarding step 4 captures a LinkedIn URL; on finish the **Profile Enrichment Agent** auto-fills bio, proof points, achievements, metrics, and tone — used by the Sequence Agent for personalization. The Profile page exposes a manual **Enrich from LinkedIn** button.
- **Run full pipeline** button on each mission orchestrates target → evidence → contacts → sequence client-side for the top 5 targets, so a fresh mission goes from blank to ready-to-review drafts in one click.
- UI surfaces an `apollo` pill on Apollo-sourced rows, an `email-status` badge (`verified` / `likely` / `guessed`) on contacts, and firmographic chips (industry, employee count) on targets.

## What's not in MVP yet

- No background job queue (long agent batches still timeout-prone past 60s).
- No follow-up scheduler (sequences exist; cron to auto-send touches 1+2 is M2).
- No suppression list / per-day send caps (M2).
- No inline draft editing or regenerate-with-feedback (M3).
- No Outlook (Gmail-only for v1).
