// One-off admin tool: HARD-DELETE a user account and ALL of its data.
//
// Usage:
//   Dry run (default — prints what WOULD be deleted, changes nothing):
//     npx tsx --env-file=.env scripts/delete-account.ts <email>
//   Execute the deletion (irreversible):
//     npx tsx --env-file=.env scripts/delete-account.ts <email> --confirm
//
// Deletes, for the user behind <email>:
//   1. every Mongo document with userId === uid across all collections,
//   2. the user's uploaded asset blobs in object storage (best-effort),
//   3. the Firebase auth user itself.
//
// userId is denormalized on every doc (BaseDoc), so a flat deleteMany per
// collection is exhaustive — no transitive (mission/target) walks needed.

import { MongoClient } from 'mongodb';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { COL } from '../api/_lib/db';
import { deleteObject } from '../api/_lib/storage';

const email = process.argv[2];
const confirm = process.argv.includes('--confirm');

if (!email) {
  console.error('Usage: tsx --env-file=.env scripts/delete-account.ts <email> [--confirm]');
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'outreachos';
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

async function main() {
  // ---- Resolve email -> Firebase UID --------------------------------------
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (raw) initializeApp({ credential: cert(JSON.parse(raw)) });
    else initializeApp(); // GOOGLE_APPLICATION_CREDENTIALS / metadata creds
  }

  let uid: string;
  try {
    const fbUser = await getAuth().getUserByEmail(email);
    uid = fbUser.uid;
  } catch {
    console.error(`[fail] No Firebase auth user found for ${email}.`);
    process.exit(1);
  }
  console.log(`[resolve] ${email} -> uid ${uid}`);

  const client = new MongoClient(MONGODB_URI!);
  await client.connect();
  const db = client.db(MONGODB_DB);

  // ---- Count per collection ------------------------------------------------
  const names = Object.values(COL);
  const counts: Record<string, number> = {};
  let total = 0;
  for (const name of names) {
    const n = await db.collection(name).countDocuments({ userId: uid });
    counts[name] = n;
    total += n;
  }

  // Gather asset storage paths up front (the docs are about to be deleted).
  const assets = await db
    .collection(COL.profileAssets)
    .find({ userId: uid }, { projection: { storagePath: 1 } })
    .toArray();
  const storagePaths = assets.map((a) => a.storagePath).filter(Boolean) as string[];

  console.log('\nDocuments owned by this user:');
  for (const name of names) {
    if (counts[name] > 0) console.log(`  ${name.padEnd(20)} ${counts[name]}`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${total}`);
  console.log(`  ${'asset blobs'.padEnd(20)} ${storagePaths.length}`);

  if (!confirm) {
    console.log('\n[dry run] Nothing deleted. Re-run with --confirm to execute.');
    await client.close();
    return;
  }

  // ---- Execute -------------------------------------------------------------
  console.log('\n[delete] Removing Mongo documents…');
  let deleted = 0;
  for (const name of names) {
    const res = await db.collection(name).deleteMany({ userId: uid });
    if (res.deletedCount) console.log(`  ${name.padEnd(20)} -${res.deletedCount}`);
    deleted += res.deletedCount;
  }
  console.log(`  Mongo docs deleted: ${deleted}`);

  console.log('[delete] Removing asset blobs from storage…');
  let blobsDeleted = 0;
  for (const p of storagePaths) {
    try {
      await deleteObject(p);
      blobsDeleted += 1;
    } catch (err) {
      console.warn(`  [warn] could not delete blob ${p}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`  Asset blobs deleted: ${blobsDeleted}/${storagePaths.length}`);

  console.log('[delete] Removing Firebase auth user…');
  await getAuth().deleteUser(uid);
  console.log(`  Firebase user ${uid} deleted.`);

  await client.close();
  console.log(`\n[ok] Account ${email} (uid ${uid}) and all its data deleted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
