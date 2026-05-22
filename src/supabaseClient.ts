// LEGACY SHIM — kept for import-path stability after the Supabase → Mongo +
// Firebase Auth migration. New code should import { db } from './lib/db' and
// the firebase/auth SDK directly.
//
// `supabase.from(...)`, `supabase.auth.*`, and `supabase.storage.*` all work
// through the same `db` object, which routes to `/api/data/*` REST endpoints
// (using a Firebase ID token) and the Firebase auth SDK.

export { db as supabase, db } from './lib/db';
