// One-shot initializer: creates all collections, regular indexes, and Atlas
// Vector Search indexes defined in shared/schemas.ts.
//
// Run with:  npm run mongo:init
//
// Idempotent — safe to re-run; existing indexes are skipped.

import { MongoClient } from 'mongodb';
import { INDEX_SPEC, VECTOR_INDEX_SPEC } from '../shared/schemas';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'outreachos';
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

async function main() {
  const client = new MongoClient(MONGODB_URI!);
  await client.connect();
  const db = client.db(MONGODB_DB);

  for (const [colName, indexes] of Object.entries(INDEX_SPEC)) {
    const collections = await db.listCollections({ name: colName }).toArray();
    if (collections.length === 0) {
      await db.createCollection(colName);
      console.log(`[create] collection ${colName}`);
    }
    const col = db.collection(colName);
    for (const idx of indexes) {
      try {
        const name = await col.createIndex(idx.keys, idx.options ?? {});
        console.log(`[index] ${colName}.${name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('already exists')) continue;
        console.error(`[index-fail] ${colName}:`, msg);
      }
    }
  }

  // Atlas Vector Search indexes.
  // Requires Atlas (not local Mongo) and driver 6.6+.
  for (const v of VECTOR_INDEX_SPEC) {
    const col = db.collection(v.collection);
    try {
      const existing = await col.listSearchIndexes(v.name).toArray();
      if (existing.length > 0) {
        console.log(`[vector] ${v.collection}.${v.name} already exists`);
        continue;
      }
      // @ts-expect-error createSearchIndex types lag the runtime
      await col.createSearchIndex({ name: v.name, type: 'vectorSearch', definition: v.definition });
      console.log(`[vector] ${v.collection}.${v.name} created`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[vector-skip] ${v.collection}.${v.name}: ${msg}`);
      console.warn('  → If this is a local Mongo, that is expected. Vector Search is Atlas-only.');
    }
  }

  await client.close();
  console.log('done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
