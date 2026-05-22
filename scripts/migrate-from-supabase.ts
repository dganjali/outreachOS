// Stub data migration script — Supabase Postgres → MongoDB Atlas.
//
// I'm leaving this as a deliberate stub. Filling it in properly requires
// looking at the actual user/row counts; running an untested script against
// a live DB would be reckless. Use this as a template.
//
// Run with:  npm run migrate:from-supabase
//
// Pre-reqs:
//   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars (temporary — for the
//     read-side of the migration only)
//   - MONGODB_URI env var
//   - Firebase service account credentials configured (we need to import
//     auth.users → Firebase Auth users to get UID mappings)
//   - tsx (already in devDependencies)

/* eslint-disable no-console */
console.error(`
This script is a stub. Implement the migration in this order:

  1. Read auth.users from Supabase Postgres directly via SQL.
  2. For each row, call firebase-admin auth.importUsers([...]) with passwordHash
     pulled from the Supabase 'encrypted_password' bcrypt column. Build a map:
       supabaseUuid -> firebaseUid
  3. For each Supabase table, read all rows and transform:
       - id -> _id (keep the uuid string as-is — Mongo accepts arbitrary _id)
       - user_id -> userId, but map through the supabase->firebase uid map
       - snake_case -> camelCase for every other field
       - created_at / updated_at strings -> new Date(...)
  4. Bulk insert into the matching Mongo collection. Tables -> collections:
       profiles, profile_versions, profile_assets, missions, targets, contacts,
       evidence_packs, email_sequences, sent_messages, replies, agent_runs,
       user_integrations
  5. user_integrations: refresh_token_encrypted and access_token_encrypted are
     opaque strings encrypted with ENCRYPTION_KEY. Carry them over verbatim;
     the same key is reused in the new stack.
  6. profile_assets: also copy the underlying files from Supabase Storage to
     Cloud Storage and rewrite storage_path -> storagePath to the GCS path.

See daniel-todo.md section 11 for the broader sequencing.
`);
process.exit(1);
