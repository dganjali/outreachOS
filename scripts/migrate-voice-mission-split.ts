// Voice/Mission/Memory-bank split migration.
//
// Finishes the data move that strips campaign substance off the voice:
//   1. Re-scopes every legacy `context_facts` doc with scope:'persona' to
//      scope:'person' (the shared memory bank), clearing personaId. These were
//      voice-owned proof; the memory bank is the safe, lossless home and the user
//      can prune later. A `missionId:null` field is set for schema consistency.
//   2. Backfills `missionId:null` / `personaId:null` on any context_facts doc
//      missing them, so the new fields read cleanly everywhere.
//   3. Backfills `scope:'person'` + `missionId:null` on profile_assets that
//      predate the asset-scope field (everything legacy = memory bank).
//
// Idempotent + non-destructive: re-running only touches docs that still look
// pre-split. Persona offer/audience values are intentionally LEFT in place
// (unread by the app); no mission backfill is needed because missions already
// carry their own offer/audience.
//
// Run with:  tsx scripts/migrate-voice-mission-split.ts            (apply)
//            tsx scripts/migrate-voice-mission-split.ts --dry-run  (report only)
// Then re-run `npm run mongo:init` on the cluster to create the new indexes.

/* eslint-disable no-console */
import { MongoClient, type Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'outreachos';
const DRY_RUN = process.argv.includes('--dry-run');

if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

interface Stats {
  personaFactsRescoped: number;
  factFieldsBackfilled: number;
  assetsBackfilled: number;
}

async function migrate(db: Db, stats: Stats): Promise<void> {
  const now = new Date();

  // 1. Legacy persona-scoped facts → memory bank (scope:'person').
  const personaFactFilter = { scope: 'persona' };
  const personaFacts = await db.collection('context_facts').countDocuments(personaFactFilter);
  if (personaFacts > 0) {
    if (DRY_RUN) {
      console.log(`[dry] re-scope ${personaFacts} persona facts → person (memory bank)`);
    } else {
      await db
        .collection('context_facts')
        .updateMany(personaFactFilter, { $set: { scope: 'person', personaId: null, missionId: null, updatedAt: now } });
    }
    stats.personaFactsRescoped += personaFacts;
  }

  // 2. Backfill the new missionId/personaId fields on any fact missing them.
  const missingFields = {
    $or: [{ missionId: { $exists: false } }, { personaId: { $exists: false } }],
  };
  const toBackfill = await db.collection('context_facts').countDocuments(missingFields);
  if (toBackfill > 0) {
    if (DRY_RUN) {
      console.log(`[dry] backfill missionId/personaId on ${toBackfill} context facts`);
    } else {
      // Set only the fields that are absent (don't clobber a real personaId/missionId).
      await db.collection('context_facts').updateMany(
        { missionId: { $exists: false } },
        { $set: { missionId: null, updatedAt: now } }
      );
      await db.collection('context_facts').updateMany(
        { personaId: { $exists: false } },
        { $set: { personaId: null, updatedAt: now } }
      );
    }
    stats.factFieldsBackfilled += toBackfill;
  }

  // 3. Backfill asset scope (legacy assets are all memory-bank).
  const assetFilter = { scope: { $exists: false } };
  const assets = await db.collection('profile_assets').countDocuments(assetFilter);
  if (assets > 0) {
    if (DRY_RUN) {
      console.log(`[dry] backfill scope:'person' on ${assets} profile assets`);
    } else {
      await db
        .collection('profile_assets')
        .updateMany(assetFilter, { $set: { scope: 'person', missionId: null, updatedAt: now } });
    }
    stats.assetsBackfilled += assets;
  }
}

async function main() {
  const client = new MongoClient(MONGODB_URI!);
  await client.connect();
  const db = client.db(MONGODB_DB);

  const stats: Stats = { personaFactsRescoped: 0, factFieldsBackfilled: 0, assetsBackfilled: 0 };

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Migrating voice/mission/memory-bank split…`);
  await migrate(db, stats);

  await client.close();
  console.log(
    `done. persona-facts re-scoped:${stats.personaFactsRescoped} ` +
      `fact-fields backfilled:${stats.factFieldsBackfilled} assets backfilled:${stats.assetsBackfilled}`
  );
  if (DRY_RUN) console.log('(dry run - no writes performed)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
