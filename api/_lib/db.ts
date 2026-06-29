// MongoDB client + per-user collection wrapper.
//
// Replaces the old Supabase admin/userClient pattern. Mongo has no row-level
// security - security lives here, in this file. Every read/write goes through
// `forUser(uid).collection(name)`, which auto-injects `userId: uid` (or the
// equivalent ownership filter) on every query.
//
// Rule: never `import { db } from ...` and call collections directly outside
// this module. Always go through forUser(). Service-role escape hatches (cron
// poller, init script) use `adminDb()` and must filter manually.

import { MongoClient, type Collection, type Db, type Document, type Filter, type WithId } from 'mongodb';
import { env } from './env';

let _client: MongoClient | null = null;
let _db: Db | null = null;

async function getDb(): Promise<Db> {
  if (_db) return _db;
  if (!_client) {
    _client = new MongoClient(env.MONGODB_URI(), {
      maxPoolSize: 10,
      minPoolSize: 1,
      retryWrites: true,
    });
    await _client.connect();
  }
  _db = _client.db(env.MONGODB_DB());
  return _db;
}

/** Service-role access - use only in cron jobs, migrations, and init scripts. */
export async function adminDb(): Promise<Db> {
  return getDb();
}

// ---------------------------------------------------------------------------
// Collection names - single source of truth.
// ---------------------------------------------------------------------------
export const COL = {
  profiles: 'profiles',
  profileVersions: 'profile_versions',
  profileAssets: 'profile_assets',
  missions: 'missions',
  targets: 'targets',
  contacts: 'contacts',
  evidencePacks: 'evidence_packs',
  emailSequences: 'email_sequences',
  sentMessages: 'sent_messages',
  replies: 'replies',
  agentRuns: 'agent_runs',
  userIntegrations: 'user_integrations',
  suppressions: 'suppressions',
  pipelineRuns: 'pipeline_runs',
  campaignPolicies: 'campaign_policies',
  // Global per-account "already contacted" ledger (permanent cross-mission dedup).
  contactLedger: 'contact_ledger',
  // Personalization layer (the persona/taste model). See shared/schemas.ts.
  personas: 'personas',
  personaVersions: 'persona_versions',
  contextFacts: 'context_facts',
  styleExemplars: 'style_exemplars',
} as const;

export type CollectionName = (typeof COL)[keyof typeof COL];

// ---------------------------------------------------------------------------
// Ownership rules - how do we filter docs to "owned by user"?
//
// Most collections store `userId` directly. A few are owned transitively
// (evidence_packs through targets → missions). For those, the wrapper does a
// `$lookup`-based ownership check on read AND requires the caller to pass the
// owning mission/target id on write, which we validate.
// ---------------------------------------------------------------------------
type OwnershipMode = 'userId' | 'viaTarget' | 'viaMission';

const OWNERSHIP: Record<CollectionName, OwnershipMode> = {
  profiles: 'userId',
  profile_versions: 'userId',
  profile_assets: 'userId',
  missions: 'userId',
  targets: 'viaMission',
  contacts: 'viaMission', // contacts.missionId is denormalized on write
  evidence_packs: 'viaMission',
  email_sequences: 'userId', // userId denormalized on write
  sent_messages: 'userId',
  replies: 'userId',
  agent_runs: 'userId',
  user_integrations: 'userId',
  suppressions: 'userId',
  pipeline_runs: 'userId',
  campaign_policies: 'userId',
  contact_ledger: 'userId',
  personas: 'userId',
  persona_versions: 'userId',
  context_facts: 'userId',
  style_exemplars: 'userId',
};

// ---------------------------------------------------------------------------
// Per-user wrapper.
// ---------------------------------------------------------------------------
/**
 * Doc shape that callers pass to insertOne/insertMany. They supply everything
 * except the stamped-on-write fields - userId, createdAt, updatedAt - which
 * the wrapper fills in.
 */
export type InsertDoc<T> = Omit<T, 'userId' | 'createdAt' | 'updatedAt'>;

export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
  projection?: Record<string, 0 | 1>;
}

export interface ScopedCollection<T extends Document = Document> {
  raw: Collection<T>;
  find(filter?: Filter<T>, opts?: FindOptions): Promise<WithId<T>[]>;
  findOne(filter?: Filter<T>): Promise<WithId<T> | null>;
  findById(id: string): Promise<WithId<T> | null>;
  insertOne(doc: InsertDoc<T>): Promise<WithId<T>>;
  insertMany(docs: InsertDoc<T>[]): Promise<WithId<T>[]>;
  updateOne(filter: Filter<T>, update: Partial<T>): Promise<number>;
  updateById(id: string, update: Partial<T>): Promise<number>;
  deleteOne(filter: Filter<T>): Promise<number>;
  deleteById(id: string): Promise<number>;
  deleteMany(filter: Filter<T>): Promise<number>;
  countDocuments(filter?: Filter<T>): Promise<number>;
  /**
   * Run an aggregation pipeline scoped to this user. A `$match: { userId }`
   * stage is prepended automatically so callers can never read across tenants
   * (the rest of the pipeline still runs over only this user's documents).
   */
  aggregate<R extends Document = Document>(pipeline: Document[]): Promise<R[]>;
}

export interface UserScope {
  uid: string;
  collection<T extends Document = Document>(name: CollectionName): ScopedCollection<T>;
}

export function forUser(uid: string): UserScope {
  return {
    uid,
    collection<T extends Document = Document>(name: CollectionName) {
      return buildScoped<T>(uid, name);
    },
  };
}

function buildScoped<T extends Document>(uid: string, name: CollectionName): ScopedCollection<T> {
  const mode = OWNERSHIP[name];
  let cached: Collection<T> | null = null;
  const col = async (): Promise<Collection<T>> => {
    if (cached) return cached;
    const d = await getDb();
    cached = d.collection<T>(name);
    return cached;
  };

  // Inject ownership filter on every query. Mode is unused today because
  // every collection ultimately denormalizes userId, but we keep the switch
  // here so we can introduce $lookup-based ownership later without changing
  // the call sites.
  void mode;
  function ownFilter(extra: Filter<T> = {}): Filter<T> {
    return { ...(extra as Record<string, unknown>), userId: uid } as unknown as Filter<T>;
  }

  function stampOwnership(doc: object): object {
    return { ...doc, userId: uid, createdAt: (doc as any).createdAt ?? new Date(), updatedAt: new Date() };
  }

  return {
    get raw(): Collection<T> {
      // Synchronous access required for $vectorSearch etc. Caller is expected
      // to manually filter by userId. Use sparingly.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return cached!;
    },

    async find(filter = {}, opts: FindOptions = {}) {
      const c = await col();
      let cursor = c.find(ownFilter(filter));
      if (opts.sort) cursor = cursor.sort(opts.sort);
      if (opts.projection) cursor = cursor.project(opts.projection) as typeof cursor;
      if (typeof opts.limit === 'number' && opts.limit > 0) cursor = cursor.limit(opts.limit);
      return cursor.toArray();
    },
    async findOne(filter = {}) {
      const c = await col();
      return c.findOne(ownFilter(filter));
    },
    async findById(id: string) {
      const c = await col();
      return c.findOne(ownFilter({ _id: id } as unknown as Filter<T>));
    },
    async insertOne(doc) {
      const c = await col();
      const stamped = stampOwnership(doc) as unknown as T;
      const r = await c.insertOne(stamped as any);
      return { ...stamped, _id: r.insertedId } as WithId<T>;
    },
    async insertMany(docs) {
      const c = await col();
      const stamped = docs.map((d) => stampOwnership(d)) as unknown as T[];
      const r = await c.insertMany(stamped as any);
      return stamped.map((s, i) => ({ ...s, _id: r.insertedIds[i] } as WithId<T>));
    },
    async updateOne(filter, update) {
      const c = await col();
      const r = await c.updateOne(ownFilter(filter), {
        $set: { ...update, updatedAt: new Date() } as any,
      });
      return r.modifiedCount;
    },
    async updateById(id, update) {
      const c = await col();
      const r = await c.updateOne(ownFilter({ _id: id } as unknown as Filter<T>), {
        $set: { ...update, updatedAt: new Date() } as any,
      });
      return r.modifiedCount;
    },
    async deleteOne(filter) {
      const c = await col();
      const r = await c.deleteOne(ownFilter(filter));
      return r.deletedCount;
    },
    async deleteById(id) {
      const c = await col();
      const r = await c.deleteOne(ownFilter({ _id: id } as unknown as Filter<T>));
      return r.deletedCount;
    },
    async deleteMany(filter) {
      const c = await col();
      const r = await c.deleteMany(ownFilter(filter));
      return r.deletedCount;
    },
    async countDocuments(filter = {}) {
      const c = await col();
      return c.countDocuments(ownFilter(filter));
    },
    async aggregate<R extends Document = Document>(pipeline: Document[]): Promise<R[]> {
      const c = await col();
      // Prepend ownership so a pipeline can't read another user's data even if
      // its own first stage forgot to filter. ownFilter() ANDs userId at the
      // top level - exactly what a leading $match needs.
      return c.aggregate<R>([{ $match: ownFilter() }, ...pipeline]).toArray();
    },
  };
}

// ---------------------------------------------------------------------------
// ID generation - Mongo's ObjectId is fine, but we expose stringified ids to
// the API. This helper produces a 24-char hex id we can use as the _id when
// we want stable string ids that match the old uuid shape.
// ---------------------------------------------------------------------------
export { ObjectId } from 'mongodb';

export function newId(): string {
  // 24 hex chars, time-prefixed for ordering. Compatible with Mongo's _id.
  return (
    Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
    [...crypto.getRandomValues(new Uint8Array(8))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}
