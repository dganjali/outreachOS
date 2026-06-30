// Backfill embeddings on context_facts that are missing them.
//
// Why: embeddings are written best-effort on fact insert (extract-context.ts,
// enrich-profile.ts). When that embed call fails, the fact is saved WITHOUT an
// `embedding`. Atlas Vector Search then can't see it, so it never surfaces in
// relevance-ranked retrieval. assemble.ts now degrades gracefully (un-embedded
// facts still surface via the find() path), but vector ranking only kicks in
// for banks larger than MAX_FACTS - this script restores ranking for those.
//
// Idempotent + non-destructive: only touches docs with no `embedding` (or an
// empty/wrong-dim one). Re-running after a partial pass continues where it left.
//
// Run with:  tsx scripts/backfill-context-embeddings.ts            (apply)
//            tsx scripts/backfill-context-embeddings.ts --dry-run  (report only)

/* eslint-disable no-console */
import { MongoClient } from 'mongodb';
import { embedOne } from '../api/_lib/embeddings';
import { EMBED_DIM } from '../api/_lib/embeddings';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'outreachos';
const DRY_RUN = process.argv.includes('--dry-run');

if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new MongoClient(MONGODB_URI as string);
  await client.connect();
  try {
    const col = client.db(MONGODB_DB).collection('context_facts');
    // Missing field, null, empty array, or wrong dimensionality all need a (re)embed.
    const stale = await col
      .find({
        $or: [
          { embedding: { $exists: false } },
          { embedding: null },
          { embedding: { $size: 0 } },
          { embedding: { $not: { $size: EMBED_DIM } } },
        ],
      })
      .project({ claim: 1 })
      .toArray();

    console.log(`${stale.length} context_facts need an embedding (dim ${EMBED_DIM}).`);
    if (DRY_RUN) {
      for (const d of stale.slice(0, 20)) console.log(`  [dry] ${d._id}: ${String(d.claim).slice(0, 60)}`);
      if (stale.length > 20) console.log(`  ...and ${stale.length - 20} more`);
      return;
    }

    let ok = 0;
    let failed = 0;
    for (const d of stale) {
      const claim = typeof d.claim === 'string' ? d.claim.trim() : '';
      if (!claim) continue;
      try {
        const embedding = await embedOne(claim, 'document');
        await col.updateOne({ _id: d._id }, { $set: { embedding } });
        ok++;
      } catch (err) {
        failed++;
        console.warn(`  failed ${d._id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`Embedded ${ok} fact${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed (re-run to retry)` : ''}.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
