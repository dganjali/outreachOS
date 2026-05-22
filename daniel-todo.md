# Daniel — what you need to do

The architecture swap is checked into the repo. Code is done. Nothing has been
deployed and nothing has been provisioned in the cloud. This file is the
ordered playbook to get from "branch on disk" to "running on Cloud Run +
Atlas + Firebase Auth."

Estimated time end-to-end: **3–4 focused hours** for happy path, plus whatever
the data migration takes (depends on row count).

---

## 0. Before you start — verify the build

```bash
npm install
npx tsc -p tsconfig.server.json --noEmit
npm run build
```

Expect TypeScript errors in some frontend pages — I did NOT touch every page
individually. The compat shim covers most call sites, but a handful of pages
may need small fixes:

- `src/components/CsvImport.tsx` — inserts targets directly; should still work
  via the shim.
- `src/lib/profileAssets.ts` — uses `supabase.storage`; shim now routes to
  Cloud Storage signed URLs.
- Anywhere that previously did `supabase.auth.signInWithPassword(...)` works
  via the shim, but pages doing `supabase.auth.onAuthStateChange(...)` will
  no-op (the AuthContext uses Firebase's `onAuthStateChanged` directly now).
- Field naming: most snake_case (`mission_id`, `created_at`) is auto-translated
  by the shim. If you hit a case where it isn't, see the section at the bottom
  of `src/lib/db.ts`.

Fix the long tail of TS errors before deploying.

---

## 1. Google Cloud project setup

```bash
# Pick a project id — used everywhere below.
export PROJECT_ID=outreachos-prod
export REGION=us-central1

gcloud projects create $PROJECT_ID
gcloud config set project $PROJECT_ID

# Enable APIs
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudtasks.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com \
  identitytoolkit.googleapis.com \
  firebase.googleapis.com
```

Link your billing account (required for Cloud Run, even with credits).

---

## 2. Firebase Auth (Identity Platform)

1. In the [Firebase console](https://console.firebase.google.com), add a
   project — use the same `$PROJECT_ID` from above so it shares the GCP project.
2. **Authentication → Sign-in method** → enable **Email/Password** and
   **Google**.
3. **Project settings → General → Your apps → Web app → register**. Copy the
   config object — you'll paste into `.env`:
   - `apiKey` → `VITE_FIREBASE_API_KEY`
   - `authDomain` → `VITE_FIREBASE_AUTH_DOMAIN`
   - `projectId` → `VITE_FIREBASE_PROJECT_ID`
   - `appId` → `VITE_FIREBASE_APP_ID`
4. **Project settings → Service accounts → Generate new private key**. Save
   the JSON. You'll upload this to Secret Manager in step 5.
5. Add your Vercel deployment URL to **Authentication → Settings → Authorized
   domains**.

---

## 3. MongoDB Atlas

1. Create an Atlas account, pick the free M0 tier for the hackathon (upgrade
   later to M10 for vector search performance).
2. **Cloud provider: Google Cloud**, region: same as `$REGION` (us-central1).
3. **Database access → add database user** with read/write privileges. Save
   the password.
4. **Network access → add IP**. Add `0.0.0.0/0` for now (or restrict to Cloud
   Run egress IPs once you have them).
5. Copy the connection string → `MONGODB_URI` in `.env`. Format:
   `mongodb+srv://USER:PASS@cluster.xxx.mongodb.net/?retryWrites=true&w=majority`
6. Initialize the schema:
   ```bash
   export MONGODB_URI='mongodb+srv://...'
   npm run mongo:init
   ```
   This creates every collection, every regular index, and attempts to create
   the three Atlas Vector Search indexes (`evidence_vector_idx`,
   `sequence_vector_idx`, `asset_vector_idx`). On M0, vector search may not be
   available — if you see warnings, that's fine, the rest of the app works
   without it; you just won't get the "exemplar past emails" retrieval in the
   sequence agent.

---

## 4. Voyage AI

1. Sign up at [voyageai.com](https://www.voyageai.com), grab an API key.
2. Set `VOYAGE_API_KEY` in `.env` and (later) Secret Manager.

---

## 5. Secret Manager — store every secret

```bash
# Helper
create_secret() {
  echo -n "$2" | gcloud secrets create "$1" --data-file=- --replication-policy=automatic
}

create_secret ANTHROPIC_API_KEY "sk-ant-..."
create_secret MONGODB_URI "mongodb+srv://..."
create_secret VOYAGE_API_KEY "pa-..."
create_secret ENCRYPTION_KEY "$(openssl rand -base64 32)"     # 32-byte AES-GCM key
create_secret CRON_SECRET    "$(openssl rand -hex 32)"        # shared with Cloud Scheduler
create_secret GOOGLE_CLIENT_ID     "xxx.apps.googleusercontent.com"
create_secret GOOGLE_CLIENT_SECRET "yyy"
create_secret APOLLO_API_KEY "zzz"   # optional, but the secret reference is wired

# Firebase service-account JSON (paste the whole JSON file as the value):
gcloud secrets create FIREBASE_SERVICE_ACCOUNT_JSON \
  --data-file=/path/to/firebase-service-account.json
```

---

## 6. Google OAuth consent (Gmail integration)

The Gmail send/poll feature still uses Google OAuth (not Firebase Auth). The
existing client ID/secret keep working — just verify:

1. [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
   — make sure it's not still pointing at the Supabase domain. Update authorized
   domains to your Vercel domain + your Cloud Run URL.
2. [Credentials](https://console.cloud.google.com/apis/credentials) → your
   OAuth 2.0 Client → **Authorized redirect URIs** → add the new callback
   URLs:
   - `https://<your-vercel-domain>/api/integrations/gmail/callback`
   - `https://outreachos-api-<hash>.a.run.app/api/integrations/gmail/callback`

---

## 7. Cloud Storage bucket

```bash
gcloud storage buckets create gs://$PROJECT_ID-assets \
  --location=$REGION --uniform-bucket-level-access
```

This holds `profile_assets` (resumes, portfolio PDFs).

---

## 8. Cloud Tasks queue (the new job queue)

```bash
gcloud tasks queues create outreach-jobs --location=$REGION

# Service account that Cloud Tasks impersonates when calling your worker.
gcloud iam service-accounts create cloud-tasks-invoker \
  --display-name="Cloud Tasks → Cloud Run invoker"
```

The invoker SA email is `cloud-tasks-invoker@$PROJECT_ID.iam.gserviceaccount.com`
— that's what you set as `CLOUD_TASKS_SERVICE_ACCOUNT`.

---

## 9. Deploy Cloud Run

```bash
gcloud artifacts repositories create outreachos \
  --repository-format=docker --location=$REGION

# Trigger Cloud Build
gcloud builds submit --config=cloudbuild.yaml
```

After the first deploy, grab the service URL:

```bash
gcloud run services describe outreachos-api --region=$REGION \
  --format='value(status.url)'
```

Update three things to reference this URL:
1. `vercel.json` — replace `outreachos-api-CHANGE_ME.a.run.app` with the real URL.
2. The Cloud Tasks invoker IAM binding:
   ```bash
   gcloud run services add-iam-policy-binding outreachos-api \
     --region=$REGION \
     --member=serviceAccount:cloud-tasks-invoker@$PROJECT_ID.iam.gserviceaccount.com \
     --role=roles/run.invoker
   ```
3. `CLOUD_TASKS_TARGET_URL` env var — point at `<service URL>/api/tasks/worker`.

---

## 10. Cloud Scheduler — replace the Vercel cron

```bash
SERVICE_URL=$(gcloud run services describe outreachos-api --region=$REGION --format='value(status.url)')
CRON_SECRET=$(gcloud secrets versions access latest --secret=CRON_SECRET)

gcloud scheduler jobs create http poll-gmail \
  --location=$REGION \
  --schedule="0 9 * * *" \
  --uri="$SERVICE_URL/api/cron/poll-gmail" \
  --http-method=POST \
  --headers="Authorization=Bearer $CRON_SECRET"
```

Same schedule as the old Vercel cron (daily at 9am). Bump frequency by changing
`--schedule` later.

---

## 11. Data migration from Supabase → Mongo

I did NOT write the migration script (it's the kind of thing that wants to
look at your actual data before running). Steps:

1. Export each Supabase table to JSON. From the Supabase dashboard SQL editor:
   ```sql
   COPY (SELECT row_to_json(t) FROM public.missions t) TO '/tmp/missions.json';
   ```
   Or via the CLI:
   ```bash
   supabase db dump --data-only --schema public > supabase_dump.sql
   ```
2. For each table, transform fields:
   - `id` → `_id` (string, not uuid object — keep the uuid value as-is)
   - `user_id` → `userId`
   - `created_at`, `updated_at` → `createdAt`, `updatedAt` (as `new Date()`)
   - All other `snake_case` → `camelCase`
   - For users: query Supabase `auth.users`, then create matching Firebase
     users via `auth.importUsers()` in firebase-admin. The Firebase UID
     becomes the new `userId` on every row. **Critical:** capture the
     old-uuid → new-firebase-uid mapping; you'll rewrite `userId` on every
     migrated row.
3. Bulk insert into Mongo:
   ```js
   await db.collection('missions').insertMany(transformedRows)
   ```
4. Verify counts match per collection.

If you'd rather start fresh (no migration), just create new accounts in
Firebase Auth and skip this step.

---

## 12. Frontend deployment (Vercel)

```bash
# Set the Vite env vars in Vercel project settings:
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...

# Deploy
vercel --prod
```

The `vercel.json` rewrites `/api/*` to your Cloud Run URL, so the React app
keeps calling `/api/agents/target` etc. exactly as before — Vercel proxies
to Cloud Run on your behalf.

---

## 13. Smoke test

In order:

1. Sign up via the Vercel-hosted UI → Firebase user appears in the console.
2. Onboarding flow → check `profiles` collection in Atlas has one doc.
3. Create a mission → check `missions` collection.
4. Run targeting agent → check `targets` and `agent_runs` collections.
5. Connect Gmail → `user_integrations` collection has a row with encrypted
   tokens.
6. Send a draft → `sent_messages` has a row, Gmail shows the draft.
7. Trigger the cron manually:
   ```bash
   curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
     $SERVICE_URL/api/cron/poll-gmail
   ```

---

## 14. Things I deliberately left for you

- **Tighter storage authorization.** The signed-upload endpoint in
  `api/data/router.ts` infers `kind` from the path. A hardened version should
  require the kind as an explicit param and verify the uid in the GCS path.
- **Removed direct DB calls from frontend.** I left a Supabase-shaped shim
  (`src/supabaseClient.ts` → `src/lib/db.ts`) so the migration doesn't require
  editing every page. Over the next few days, please:
  1. Replace `supabase.from('x')...` call sites with explicit `fetch('/api/data/x/query')` calls.
  2. Delete `src/supabaseClient.ts` and `src/lib/db.ts` (the shim) once everything's migrated.
  3. Move auth method calls (`supabase.auth.signInWithPassword`) onto Firebase Auth's SDK directly.
- **Atlas Vector Search semantic dedup of targets** — wired the embedding
  fields and indexes but the dedup feature isn't built yet. Pattern is in
  `api/agents/sequence.ts` (`fetchReplyExemplars`); replicate for the target
  agent.
- **Migrate the user collection.** Firebase doesn't store a profile doc by
  default — the `profiles` collection is yours to populate. The onboarding
  flow already does this, but for existing users you'll need to backfill.
- **A unit test or two**, especially around `forUser(uid)` ownership filters.
  The whole RLS-replacement story rides on those.

---

## What's already done in the repo

For your reference, this branch contains:

- `api/_lib/{db,auth,embeddings,storage,queue,env,runs,gmail,anthropic,apollo,prompts,crypto}.ts`
- `api/agents/{target,contacts,evidence,sequence,reply,coach,parse-resume,enrich-profile}.ts` — all rewritten for Mongo + Firebase
- `api/integrations/gmail/{start,callback,status,disconnect}.ts` — rewritten for Mongo
- `api/gmail/send.ts` — rewritten
- `api/cron/poll-gmail.ts` — rewritten, uses CRON_SECRET header auth
- `api/tasks/worker.ts` — NEW — Cloud Tasks worker dispatch
- `api/data/router.ts` — NEW — generic CRUD for frontend + storage signing
- `server/index.ts` — NEW — Cloud Run Express entry point
- `shared/schemas.ts` — NEW — Mongo collection types + index spec
- `scripts/init-mongo.ts` — NEW — provisions collections + indexes + vector indexes
- `src/firebaseClient.ts` — NEW — Firebase Auth SDK init
- `src/context/AuthContext.tsx` — rewritten for Firebase
- `src/lib/api.ts` — updated to send Firebase JWT
- `src/lib/db.ts` — NEW — Supabase-shaped shim over `/api/data/*`
- `src/supabaseClient.ts` — now a 3-line re-export shim, will be deleted later
- `Dockerfile`, `.dockerignore`, `cloudbuild.yaml`, `tsconfig.server.json`
- `vercel.json` — stripped of functions/crons, just rewrites + SPA fallback

Deleted: `supabase/` directory, old `ARCHITECTURE.md`, old `todo.md`.

Good luck. Ping me if anything's confusing.
