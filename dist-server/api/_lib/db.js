// MongoDB client + per-user collection wrapper.
//
// Replaces the old Supabase admin/userClient pattern. Mongo has no row-level
// security — security lives here, in this file. Every read/write goes through
// `forUser(uid).collection(name)`, which auto-injects `userId: uid` (or the
// equivalent ownership filter) on every query.
//
// Rule: never `import { db } from ...` and call collections directly outside
// this module. Always go through forUser(). Service-role escape hatches (cron
// poller, init script) use `adminDb()` and must filter manually.
import { MongoClient } from 'mongodb';
import { env } from './env';
let _client = null;
let _db = null;
async function getDb() {
    if (_db)
        return _db;
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
/** Service-role access — use only in cron jobs, migrations, and init scripts. */
export async function adminDb() {
    return getDb();
}
// ---------------------------------------------------------------------------
// Collection names — single source of truth.
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
};
const OWNERSHIP = {
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
};
export function forUser(uid) {
    return {
        uid,
        collection(name) {
            return buildScoped(uid, name);
        },
    };
}
function buildScoped(uid, name) {
    const mode = OWNERSHIP[name];
    let cached = null;
    const col = async () => {
        if (cached)
            return cached;
        const d = await getDb();
        cached = d.collection(name);
        return cached;
    };
    // Inject ownership filter on every query. Mode is unused today because
    // every collection ultimately denormalizes userId, but we keep the switch
    // here so we can introduce $lookup-based ownership later without changing
    // the call sites.
    void mode;
    function ownFilter(extra = {}) {
        return { ...extra, userId: uid };
    }
    function stampOwnership(doc) {
        return { ...doc, userId: uid, createdAt: doc.createdAt ?? new Date(), updatedAt: new Date() };
    }
    return {
        get raw() {
            // Synchronous access required for $vectorSearch etc. Caller is expected
            // to manually filter by userId. Use sparingly.
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            return cached;
        },
        async find(filter = {}) {
            const c = await col();
            return c.find(ownFilter(filter)).toArray();
        },
        async findOne(filter = {}) {
            const c = await col();
            return c.findOne(ownFilter(filter));
        },
        async findById(id) {
            const c = await col();
            return c.findOne(ownFilter({ _id: id }));
        },
        async insertOne(doc) {
            const c = await col();
            const stamped = stampOwnership(doc);
            const r = await c.insertOne(stamped);
            return { ...stamped, _id: r.insertedId };
        },
        async insertMany(docs) {
            const c = await col();
            const stamped = docs.map((d) => stampOwnership(d));
            const r = await c.insertMany(stamped);
            return stamped.map((s, i) => ({ ...s, _id: r.insertedIds[i] }));
        },
        async updateOne(filter, update) {
            const c = await col();
            const r = await c.updateOne(ownFilter(filter), {
                $set: { ...update, updatedAt: new Date() },
            });
            return r.modifiedCount;
        },
        async updateById(id, update) {
            const c = await col();
            const r = await c.updateOne(ownFilter({ _id: id }), {
                $set: { ...update, updatedAt: new Date() },
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
            const r = await c.deleteOne(ownFilter({ _id: id }));
            return r.deletedCount;
        },
        async countDocuments(filter = {}) {
            const c = await col();
            return c.countDocuments(ownFilter(filter));
        },
    };
}
// ---------------------------------------------------------------------------
// ID generation — Mongo's ObjectId is fine, but we expose stringified ids to
// the API. This helper produces a 24-char hex id we can use as the _id when
// we want stable string ids that match the old uuid shape.
// ---------------------------------------------------------------------------
export { ObjectId } from 'mongodb';
export function newId() {
    // 24 hex chars, time-prefixed for ordering. Compatible with Mongo's _id.
    return (Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') +
        [...crypto.getRandomValues(new Uint8Array(8))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join(''));
}
export async function closeDb() {
    if (_client) {
        await _client.close();
        _client = null;
        _db = null;
    }
}
