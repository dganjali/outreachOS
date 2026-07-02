# claudecontext

The standing guide for how Claude Code should work in this repo. Read it first. Keep it current.

## Working agreement (read this every time)

- **Ship to main, no branches for now.** Commit directly to `main`. Don't create feature branches.
- **After any task is finished: push to GitHub, then deploy to Google Cloud, then update this file.** All three, in that order, every time. "Finished" means the change is committed and green.
- **Keep it simple.** Smallest change that does the job. Match the surrounding code. Don't add abstractions, docs, or tooling nobody asked for.
- **Secrets live on Google Cloud (Secret Manager).** Never hardcode or commit secrets. If a task needs a *new* secret, stop and tell the user — they have to create it; don't invent values or work around it.
- **Temporary markdown files: delete them when done.** If you scaffold a scratch `.md` (a plan, a handoff, a checklist) and the work it tracked is complete, remove it. **Never delete this file (`claudecontext.md`).**
- **No em dashes or en dashes** in emails, UI copy, or new code.

## Finish-a-task checklist

1. Make the change; keep it scoped and simple.
2. Verify it's green: `npm run server:typecheck && npm test` (the Cloud Build deploy gate runs these — a red result blocks deploy).
3. Commit to `main` with a terse message.
4. **Push:** `git push origin main`.
5. **Deploy to Google Cloud** (see below).
6. **Update this file** if anything here changed (new file, new secret, new command, new convention).
7. Delete any temporary markdown you created for the task.

## Deploy commands

**Frontend** (Firebase Hosting, rewrites `/api/**` to Cloud Run):
```
npm run build && npx firebase-tools deploy --only hosting
```
Primary domain (live site): **https://outreachos.app** — this is the canonical URL now. Firebase default URL https://outreachos-495414.web.app still serves the same hosting. Bare `firebase` is not on PATH, use `npx firebase-tools`.

**Backend** (Cloud Run service `outreachos-api`, us-central1):
```
gcloud builds submit --config cloudbuild.yaml --substitutions _TAG=$(git rev-parse --short HEAD) .
```
Cloud Build step 0 runs `npm ci && npm run server:typecheck && npm test` before the Docker build, so a red typecheck/test blocks the deploy. The build uploads the working tree, not git HEAD.

**Health check:** `curl https://outreachos.app/api/healthz` → `{"ok":true}` (use `/api/healthz`, not `/healthz` — GFE swallows the latter on the public URL).

Deploy whichever side(s) the task touched (frontend, backend, or both).

## Secrets

Stored in Google Secret Manager, referenced as `:latest` in `cloudbuild.yaml`. To add a version to an existing secret:
```
printf '%s' 'value' | gcloud secrets versions add NAME --data-file=-
```
The Cloud Run runtime SA (default compute SA) needs `roles/secretmanager.secretAccessor` on each secret. If a task introduces a brand-new secret, tell the user to create it — don't proceed silently.

## What this project is

OutreachOS: agent-powered cold outreach. A React SPA talks to a Node/Express API that runs a multi-agent pipeline (targeting → contacts → evidence → sequence/draft) to produce grounded outreach emails.

**Stack:** React 18 + Vite (Firebase Hosting) · Node + Express (Cloud Run, `outreachos-api`) · Firebase Auth · MongoDB Atlas + Atlas Vector Search · Google Cloud Storage · Google Gemini 2.5 on Vertex AI (Flash for research/extraction, Pro for drafting) · Gmail OAuth (send-only) for sending.

## Layout — where things live

| Path | What's there |
|---|---|
| `src/` | React SPA. `pages/` are routed screens (`MissionPage`, `Me`, `Dashboard`, `Analytics`, `Onboarding`…). The mission screen is tabbed (Pipeline / Setup / Activity, via `?tab=`). No Inbox: Gmail is send-only so replies are never ingested. `components/` shared UI (incl. `persona/`, `ui/`). `lib/` client helpers — `api.ts` is the REST client, `personas.ts`/`profileAssets.ts` profile + asset logic. `types.ts` shared client types. |
| `api/` | Backend request handlers, grouped by domain: `agents/` (LLM agents — `calibrate-draft`, `draft`, `extract-context`, `enrich-profile`, `contacts`, `people`, `sequence`…), `data/` (CRUD), `gmail/`, `integrations/`, `billing/`, `cron/`. |
| `api/_lib/` | Backend internals: `llm.ts` (Gemini), `db.ts` (Mongo), `auth.ts`, `engine.ts`/`pipeline.ts` (orchestration), `assemble.ts` (prompt assembly), `embeddings.ts`, contact/email resolution (`email-finder`, `email-resolver`, `email-verifier`, `contact-verify`), `env.ts` (fail-fast required-env check), `prompts.ts`. Tests sit next to sources as `*.test.ts`. |
| `shared/` | Code shared by client + server: `schemas.ts` (Zod), `types.ts`, `plans.ts`, `deliverability.ts`. |
| `server/index.ts` | Express entrypoint — wires every `/api/*` route, runs on Cloud Run. |
| `scripts/` | One-off ops: data migrations (`migrate-*`), `init-mongo.ts`, `set-plan.ts`, `eval/` (prompt-quality eval harness). |
| `cloudbuild.yaml` · `Dockerfile` · `firebase.json` | Deploy config: Cloud Build pipeline, backend container, Hosting + `/api` rewrite. |
| `*.md` (root) | Living docs: `README`, `ARCHITECTURE`, `PRODUCT`, `VISION`, `DESIGN`, `CONTACT_ENGINE`, `MONETIZATION`, `SECURITY_AUDIT`, `TODO`. Background, not instructions. |

## Conventions

- **Tests:** `npm test` (`tsx --test api/**/*.test.ts`). Add/adjust the colocated `*.test.ts` when you change backend logic.
- **Typecheck:** `npm run server:typecheck` for the backend; the Vite build typechecks the frontend.
- **Dev:** `npm run dev` (SPA) and `npm run server:dev` (API, reads `.env`).
- Commit messages are terse and direct.
