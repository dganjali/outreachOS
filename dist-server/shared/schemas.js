// MongoDB collection schemas — the single place that describes what every
// collection looks like. `init-mongo.ts` reads INDEX_SPEC from here to create
// all indexes (including the Atlas Vector Search index).
//
// Note: ids are stored as 24-hex strings (matches the old uuid shape from
// Postgres), generated via `newId()` in api/_lib/db.ts. We use string `_id`
// rather than ObjectId everywhere so that the API layer can pass ids through
// unchanged from the frontend.
//
// Every document has:
//   _id: string
//   userId: string         (Firebase UID — denormalized on every doc for O(1) ownership checks)
//   createdAt: Date
//   updatedAt: Date
// These are stamped by the `forUser(uid).collection().insertOne()` wrapper.
void {}; // keep the import live for downstream consumers
// ---------------------------------------------------------------------------
// Index spec — read by scripts/init-mongo.ts. Plain JS so the script doesn't
// need to import any types.
// ---------------------------------------------------------------------------
export const INDEX_SPEC = {
    profiles: [
        { keys: { userId: 1 }, options: { unique: true } },
    ],
    profile_versions: [
        { keys: { userId: 1, createdAt: -1 } },
    ],
    profile_assets: [
        { keys: { userId: 1, createdAt: -1 } },
        { keys: { userId: 1, kind: 1 } },
    ],
    missions: [
        { keys: { userId: 1, createdAt: -1 } },
        { keys: { userId: 1, archivedAt: 1 } },
    ],
    targets: [
        { keys: { userId: 1, missionId: 1, status: 1 } },
        { keys: { userId: 1, missionId: 1, apolloOrganizationId: 1 } },
    ],
    contacts: [
        { keys: { userId: 1, targetId: 1, status: 1 } },
        { keys: { userId: 1, targetId: 1, apolloPersonId: 1 } },
    ],
    evidence_packs: [
        { keys: { userId: 1, targetId: 1, createdAt: -1 } },
    ],
    email_sequences: [
        { keys: { userId: 1, missionId: 1, status: 1 } },
        { keys: { userId: 1, contactId: 1, createdAt: -1 } },
        { keys: { userId: 1, scheduledSendAt: 1 }, options: { partialFilterExpression: { status: 'approved' } } },
    ],
    sent_messages: [
        { keys: { userId: 1, sentAt: -1 } },
        { keys: { userId: 1, sequenceId: 1, touchIndex: 1 }, options: { unique: true } },
        { keys: { gmailThreadId: 1 }, options: { sparse: true } },
        { keys: { status: 1, scheduledSendAt: 1 }, options: { partialFilterExpression: { status: 'queued' } } },
    ],
    replies: [
        { keys: { userId: 1, handled: 1, receivedAt: -1 } },
        { keys: { gmailMessageId: 1 }, options: { unique: true, sparse: true } },
    ],
    agent_runs: [
        { keys: { userId: 1, startedAt: -1 } },
        { keys: { userId: 1, missionId: 1, startedAt: -1 } },
        // TTL: drop after 30 days to keep telemetry costs flat.
        { keys: { startedAt: 1 }, options: { expireAfterSeconds: 60 * 60 * 24 * 30 } },
    ],
    user_integrations: [
        { keys: { userId: 1, provider: 1 }, options: { unique: true } },
    ],
};
/**
 * Atlas Vector Search index definitions. These can't be created via the Node
 * driver's regular createIndex — they go through the Atlas Admin API or the
 * `db.collection.createSearchIndex()` helper (driver 6.6+).
 */
export const VECTOR_INDEX_SPEC = [
    {
        collection: 'evidence_packs',
        name: 'evidence_vector_idx',
        definition: {
            fields: [
                { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
                { type: 'filter', path: 'userId' },
                { type: 'filter', path: 'missionId' },
            ],
        },
    },
    {
        collection: 'email_sequences',
        name: 'sequence_vector_idx',
        definition: {
            fields: [
                { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
                { type: 'filter', path: 'userId' },
                { type: 'filter', path: 'status' },
            ],
        },
    },
    {
        collection: 'profile_assets',
        name: 'asset_vector_idx',
        definition: {
            fields: [
                { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
                { type: 'filter', path: 'userId' },
                { type: 'filter', path: 'kind' },
            ],
        },
    },
];
