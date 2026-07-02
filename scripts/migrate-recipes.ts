// Mission Recipe migration (Phase 3) - backfills a mission_recipes doc for every
// mission from its legacy campaign_policies doc + latest pipeline_run config.
//
// The recipe subsumes campaign_policies: the send/verification stages carry the
// automation cadence, guardrails, and operational counters (lastSourcedAt,
// counter) that used to live on the policy. The person/sector selections the
// autopilot used to inherit from the last manual run are seeded here too, so a
// migrated mission behaves EXACTLY as it did before.
//
// Idempotent + non-destructive: it never overwrites an existing recipe and never
// deletes campaign_policies (retire that collection manually only after the app
// cutover is verified in production). Per-mission guard keys off "does this
// mission already have a recipe" so re-running is a no-op.
//
// The defaulting here mirrors api/_lib/recipe.ts:buildRecipeStages. It is
// re-implemented locally (no app deps) so the script stays offline, matching the
// other migrate-*.ts scripts.
//
// Run with:  npm run migrate:recipes              (apply)
//            npm run migrate:recipes -- --dry-run  (report only)
// Then re-run `npm run mongo:init` to create the mission_recipes indexes.

/* eslint-disable no-console */
import { MongoClient, type Db } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'outreachos';
const DRY_RUN = process.argv.includes('--dry-run');
// contact_verify defaults on unless explicitly disabled (mirrors env.ts).
const CONTACT_VERIFY_DEFAULT = !/^(0|false|off)$/i.test(process.env.CONTACT_VERIFY_ENABLED ?? '');

if (!MONGODB_URI) {
  console.error('MONGODB_URI not set');
  process.exit(1);
}

// Mirror of api/_lib/db.ts newId().
function newId(): string {
  return (
    Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
    [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
  );
}

// Defaults + bounds, kept in sync with api/_lib/recipe.ts + autopilot.ts.
const DEFAULTS = {
  targetCount: 8, topN: 5, topContacts: 1, touches: 3,
  autoSend: false, cycleIntervalHours: 24, dailySendCap: 10, minConfidence: 0.6,
  sendWindow: { startHour: 9, endHour: 17 }, timezone: 'America/Toronto',
};
const MAX = { targetCount: 25, topN: 15, topContacts: 5, touches: 5, cycleIntervalHours: 24 * 14, dailySendCap: 100 };
const LEVELS = new Set(['ic', 'senior_ic', 'lead', 'manager', 'senior_manager', 'director', 'senior_director', 'vp', 'svp', 'cxo', 'founder']);

const clamp = (n: number, lo: number, hi: number) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo);
function cleanStrings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = typeof s === 'string' ? s.trim() : '';
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}
const cleanLevels = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list)].filter((l) => typeof l === 'string' && LEVELS.has(l)) : [];

interface Stats { recipesCreated: number; missionsSkipped: number; }

async function run(db: Db): Promise<Stats> {
  const stats: Stats = { recipesCreated: 0, missionsSkipped: 0 };
  const missions = await db.collection('missions').find({}).toArray();

  for (const mission of missions) {
    const missionId = mission._id as unknown as string;
    const userId = mission.userId as string;

    const existing = await db.collection('mission_recipes').findOne({ missionId });
    if (existing) { stats.missionsSkipped++; continue; }

    const policy = await db.collection('campaign_policies').findOne({ missionId });
    const runs = await db
      .collection('pipeline_runs')
      .find({ missionId }).sort({ createdAt: -1 }).limit(1).toArray();
    const cfg = runs[0]?.config ?? null;

    const findMode = mission.findMode === 'people' ? 'people' : 'companies';
    const targetsPerCycle: number | undefined = policy?.targetsPerCycle;
    const count = clamp(Math.round(Math.max(targetsPerCycle ?? 0, cfg?.targetCount ?? 0, DEFAULTS.targetCount)), 1, MAX.targetCount);
    const topN = clamp(Math.round(targetsPerCycle ?? cfg?.topN ?? DEFAULTS.topN), 1, MAX.topN);
    const contactsPerCompany = findMode === 'people'
      ? 1
      : clamp(Math.round(cfg?.topContacts ?? DEFAULTS.topContacts), 1, MAX.topContacts);
    const win = policy?.sendWindow && typeof policy.sendWindow.startHour === 'number'
      && typeof policy.sendWindow.endHour === 'number' && policy.sendWindow.endHour > policy.sendWindow.startHour
      ? { startHour: Math.round(policy.sendWindow.startHour), endHour: Math.round(policy.sendWindow.endHour) }
      : { ...DEFAULTS.sendWindow };

    const now = new Date();
    const doc = {
      _id: newId(),
      userId,
      missionId,
      automationEnabled: policy?.enabled ?? false,
      sourcing: { type: 'sourcing', enabled: true, provider: 'web_search', findMode, count, topN, sectors: cleanStrings(cfg?.selectedSectors) },
      verification: {
        type: 'verification', enabled: true, emailVerify: true, contactVerify: CONTACT_VERIFY_DEFAULT,
        minConfidence: clamp(policy?.minConfidence ?? DEFAULTS.minConfidence, 0, 1),
      },
      research: { type: 'research', enabled: true, evidence: true, companyEnrich: true },
      personSourcing: {
        type: 'personSourcing', enabled: true, contactsPerCompany,
        functions: cleanStrings(cfg?.selectedFunctions), seniority: cleanLevels(cfg?.selectedSeniority),
      },
      sequencing: { type: 'sequencing', enabled: true, touches: DEFAULTS.touches },
      send: {
        type: 'send', enabled: true,
        autoSend: policy?.autoSend ?? DEFAULTS.autoSend,
        cycleIntervalHours: clamp(Math.round(policy?.cycleIntervalHours ?? DEFAULTS.cycleIntervalHours), 1, MAX.cycleIntervalHours),
        dailySendCap: clamp(Math.round(policy?.dailySendCap ?? DEFAULTS.dailySendCap), 1, MAX.dailySendCap),
        sendWindow: win,
        timezone: (policy?.timezone ?? DEFAULTS.timezone) || DEFAULTS.timezone,
        lastSourcedAt: policy?.lastSourcedAt ?? null,
        counter: policy?.counter ?? null,
      },
      createdAt: now,
      updatedAt: now,
    };

    if (DRY_RUN) {
      console.log(`[dry-run] would create recipe for mission ${missionId} (automation=${doc.automationEnabled}, contacts/co=${contactsPerCompany}, topN=${topN})`);
    } else {
      // Mongo driver types _id as ObjectId; cast as the app's db.ts insertOne does.
      await db.collection('mission_recipes').insertOne(doc as never);
    }
    stats.recipesCreated++;
  }
  return stats;
}

async function main() {
  const client = new MongoClient(MONGODB_URI as string);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Migrating missions -> mission_recipes...`);
    const stats = await run(db);
    console.log('Done:', stats);
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
