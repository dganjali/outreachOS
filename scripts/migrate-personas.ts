// Persona migration - backfills the personalization layer for existing users.
//
// For every `profiles` doc it:
//   1. Creates a default PersonaDoc (seeded from the profile's writing tone), if
//      the user has none yet.
//   2. Converts the freeform proofPoints / achievements / metrics blobs into
//      atomic ContextFactDoc(scope:'person') rows.
//   3. Converts the exampleEmails blob into StyleExemplarDoc rows.
//   4. Backfills missions.personaId to the default persona.
//
// Idempotent + non-destructive: it never deletes or overwrites user data, and
// each step is guarded so re-running is a no-op. Per-user guards key off "does
// this user already have any persona / context fact / exemplar" rather than a
// migration marker, so we never duplicate and never clobber data the user has
// since created.
//
// NOTE: facts/exemplars are written WITHOUT embeddings - generating them needs
// live Vertex creds, which this offline script doesn't assume. The draft engine
// falls back to recency when embeddings are absent; run a separate embedding
// backfill (or let the learning loop re-embed) to enable vector retrieval.
//
// Run with:  npm run migrate:personas        (apply)
//            npm run migrate:personas -- --dry-run   (report only)
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

// Mirror of api/_lib/db.ts newId() - kept local so this script has no app deps.
function newId(): string {
  return (
    Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
    [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

// Split a freeform blob into atomic claims: one per non-empty line, with any
// leading bullet/number markers stripped. Conservative - no LLM, no merging.
function toClaims(blob: string | null | undefined): string[] {
  if (!blob) return [];
  return blob
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length > 0);
}

// Split an example-emails blob into individual emails on a "---" separator line;
// otherwise treat the whole blob as one exemplar.
function toExemplars(blob: string | null | undefined): string[] {
  if (!blob || !blob.trim()) return [];
  const parts = blob.split(/^\s*-{3,}\s*$/m).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [blob.trim()];
}

interface Stats {
  personasCreated: number;
  factsCreated: number;
  exemplarsCreated: number;
  missionsBackfilled: number;
  usersSkipped: number;
}

async function migrateUser(db: Db, profile: Record<string, any>, stats: Stats): Promise<void> {
  const userId: string = profile.userId;
  const now = new Date();

  // 1. Default persona (one guard: any existing persona ⇒ already migrated).
  const existingPersona = await db.collection('personas').findOne({ userId });
  let personaId: string;
  if (existingPersona) {
    personaId = String(existingPersona._id);
    stats.usersSkipped += 1;
  } else {
    personaId = newId();
    const personaDoc = {
      _id: personaId,
      userId,
      name: 'Default',
      mode: null,
      offer: null,
      audience: null,
      styleProfile: {
        dimensions: {},
        rules: [],
        bannedPhrases: [],
        voiceSummary: typeof profile.writingTone === 'string' ? profile.writingTone : '',
      },
      styleProfileVersion: 1,
      onboardingCompletedAt: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (DRY_RUN) {
      console.log(`[dry] persona "Default" for ${userId}`);
    } else {
      // String _id (matches the app's id scheme); the driver's default type
      // expects ObjectId, so cast - same as api/_lib/db.ts insertOne.
      await db.collection('personas').insertOne(personaDoc as never);
    }
    stats.personasCreated += 1;
  }

  // 2. Context facts - only if the user has none (don't duplicate / clobber).
  const factCount = await db.collection('context_facts').countDocuments({ userId });
  if (factCount === 0) {
    const factSpecs: Array<{ blob: any; type: string }> = [
      { blob: profile.proofPoints, type: 'proof' },
      { blob: profile.achievements, type: 'proof' },
      { blob: profile.metrics, type: 'metric' },
    ];
    const docs: Record<string, any>[] = [];
    for (const { blob, type } of factSpecs) {
      for (const claim of toClaims(blob)) {
        docs.push({
          _id: newId(),
          userId,
          scope: 'person',
          personaId: null,
          type,
          claim,
          date: null,
          evidenceUrl: null,
          provenance: 'manual',
          confidence: 0.6,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
    if (docs.length > 0) {
      if (DRY_RUN) console.log(`[dry] ${docs.length} context facts for ${userId}`);
      else await db.collection('context_facts').insertMany(docs as never[]);
      stats.factsCreated += docs.length;
    }
  }

  // 3. Style exemplars - only if the user has none.
  const exemplarCount = await db.collection('style_exemplars').countDocuments({ userId });
  if (exemplarCount === 0) {
    const bodies = toExemplars(profile.exampleEmails);
    const docs = bodies.map((body) => ({
      _id: newId(),
      userId,
      personaId,
      subject: null,
      body,
      mode: null,
      source: 'user-provided',
      outcome: 'unknown',
      createdAt: now,
      updatedAt: now,
    }));
    if (docs.length > 0) {
      if (DRY_RUN) console.log(`[dry] ${docs.length} exemplars for ${userId}`);
      else await db.collection('style_exemplars').insertMany(docs as never[]);
      stats.exemplarsCreated += docs.length;
    }
  }

  // 4. Backfill missions.personaId for this user's personaless missions.
  const missionFilter = { userId, $or: [{ personaId: null }, { personaId: { $exists: false } }] };
  const toBackfill = await db.collection('missions').countDocuments(missionFilter);
  if (toBackfill > 0) {
    if (DRY_RUN) {
      console.log(`[dry] backfill ${toBackfill} missions → persona ${personaId} for ${userId}`);
    } else {
      await db.collection('missions').updateMany(missionFilter, { $set: { personaId, updatedAt: now } });
    }
    stats.missionsBackfilled += toBackfill;
  }
}

async function main() {
  const client = new MongoClient(MONGODB_URI!);
  await client.connect();
  const db = client.db(MONGODB_DB);

  const stats: Stats = {
    personasCreated: 0,
    factsCreated: 0,
    exemplarsCreated: 0,
    missionsBackfilled: 0,
    usersSkipped: 0,
  };

  const profiles = await db.collection('profiles').find({}).toArray();
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Migrating ${profiles.length} profile(s)…`);

  for (const profile of profiles) {
    if (!profile.userId) {
      console.warn(`[skip] profile ${profile._id} has no userId`);
      continue;
    }
    await migrateUser(db, profile as Record<string, any>, stats);
  }

  await client.close();
  console.log(
    `done. personas:+${stats.personasCreated} facts:+${stats.factsCreated} ` +
      `exemplars:+${stats.exemplarsCreated} missions backfilled:${stats.missionsBackfilled} ` +
      `users already migrated:${stats.usersSkipped}`
  );
  if (DRY_RUN) console.log('(dry run - no writes performed)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
