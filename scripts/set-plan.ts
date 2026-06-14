// One-off admin tool: grant a plan to a user by email (bypasses Stripe).
//
// Usage:
//   npx tsx --env-file=.env scripts/set-plan.ts <email> [planId]
//   npx tsx --env-file=.env scripts/set-plan.ts me@example.com scale
//
// planId defaults to 'scale' (Pro Scale). Sets planStatus='active' and a
// one-year renewal date so the plan reads as fully paid in the billing UI.

import { MongoClient } from 'mongodb';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { isPlanId, type PlanId } from '../shared/plans';

const email = process.argv[2];
const plan = (process.argv[3] ?? 'scale') as PlanId;

if (!email) {
  console.error('Usage: tsx --env-file=.env scripts/set-plan.ts <email> [planId]');
  process.exit(1);
}
if (!isPlanId(plan)) {
  console.error(`Invalid plan "${plan}". Expected one of: free, starter, pro, scale`);
  process.exit(1);
}

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'outreachos';
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

async function main() {
  // Resolve email -> Firebase UID.
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (raw) initializeApp({ credential: cert(JSON.parse(raw)) });
    else initializeApp(); // GOOGLE_APPLICATION_CREDENTIALS / metadata creds
  }
  const fbUser = await getAuth().getUserByEmail(email);
  const uid = fbUser.uid;
  console.log(`[resolve] ${email} -> uid ${uid}`);

  const client = new MongoClient(MONGODB_URI!);
  await client.connect();
  const db = client.db(MONGODB_DB);

  const now = new Date();
  const renewsAt = new Date(now.getTime() + 365 * 86_400_000);

  const res = await db.collection('profiles').updateOne(
    { userId: uid },
    {
      $set: {
        plan,
        planStatus: 'active',
        planRenewsAt: renewsAt,
        planUpdatedAt: now,
        updatedAt: now,
      },
    },
  );

  if (res.matchedCount === 0) {
    console.error(`[fail] No profile found for uid ${uid}. Has this user completed onboarding?`);
    process.exit(1);
  }
  console.log(`[ok] Set ${email} to plan "${plan}" (active). modified=${res.modifiedCount}`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
