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

import type { EmbedInputType } from '../api/_lib/embeddings';
import type { PlanId, PlanStatus } from './plans';

void ({} as EmbedInputType); // keep the import live for downstream consumers

// ---------------------------------------------------------------------------
// Document shapes (TypeScript, not Mongo validators).
// We intentionally keep validators OFF for hackathon velocity — add later via
// db.command({ collMod: ..., validator: ... }) if you want them.
// ---------------------------------------------------------------------------

export interface BaseDoc {
  _id: string;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileDoc extends BaseDoc {
  name: string | null;
  role: string | null;
  organization: string | null;
  bio: string | null;
  resumeUrl: string | null;
  linkedinUrl: string | null;
  website: string | null;
  portfolioLinks: string[] | null;
  proofPoints: string | null;
  achievements: string | null;
  metrics: string | null;
  exampleEmails: string | null;
  writingTone: string | null;
  linkedinData: Record<string, unknown> | null;
  linkedinEnrichedAt: Date | null;
  linkedinSource: 'apollo' | 'web_search' | null;
  onboardingStep: number;
  onboardingCompletedAt: Date | null;
  // When true, the follow-up sweeper skips this user's scheduled touches.
  pauseFollowups?: boolean;
  // Billing plan (absent == free tier). See shared/plans.ts.
  plan?: PlanId | null;
  planStatus?: PlanStatus | null;
  // Monotonic monthly mission-launch counter, the source of truth for the
  // monthly cap. `period` is the UTC 'YYYY-MM' the count applies to; a new month
  // lazily resets `used` to 0. NEVER decremented on mission delete — counting
  // live mission docs instead would let a user mint unlimited missions by
  // delete-and-recreate. Incremented in api/data/router.ts on mission insert.
  missionQuota?: { period: string; used: number } | null;
}

// Email addresses that must never be contacted (unsubscribe, bounce, manual).
export interface SuppressionDoc extends BaseDoc {
  email: string; // lowercased
  reason: 'unsubscribe' | 'bounce' | 'manual' | 'complaint';
  note: string | null;
}

export interface ProfileVersionDoc extends BaseDoc {
  snapshot: Record<string, unknown>;
  source: 'manual' | 'enrich' | 'coach' | 'import' | 'restore';
  label: string | null;
}

export interface ProfileAssetDoc extends BaseDoc {
  kind: 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot';
  storagePath: string;       // GCS path (NOT a URL)
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  parsedText: string | null;
  parsedFields: Record<string, unknown> | null;
  parsedAt: Date | null;
  parseError: string | null;
  sourceUrl: string | null;
  // Vector field — populated for resume chunks so the sequence agent can
  // semantically retrieve relevant snippets instead of stuffing the whole CV.
  embedding?: number[];
}

export interface MissionDoc extends BaseDoc {
  name: string;
  goal: string;
  targetDescription: string;
  mode: 'sponsorship' | 'bd' | 'internship' | 'recruiting' | 'sales';
  offerDetails: string | null;
  status: string;
  archivedAt: Date | null;
}

export interface TargetDoc extends BaseDoc {
  missionId: string;
  companyName: string;
  domain: string | null;
  score: number | null;
  whyNow: string | null;
  fitReason: string | null;
  signalType: string | null;
  status: 'suggested' | 'approved' | 'rejected' | 'contacted';
  source: 'web_search' | 'apollo' | 'csv' | 'manual';
  apolloOrganizationId: string | null;
  industry: string | null;
  employeeCount: number | null;
  headquartersLocation: string | null;
}

export interface ContactDoc extends BaseDoc {
  targetId: string;
  missionId: string; // denormalized for ownership filter
  name: string;
  role: string;
  email: string | null;
  emailStatus: 'verified' | 'likely' | 'guessed' | 'none';
  // Which rung of the resolution cascade produced the email (analytics only).
  // Optional — pre-existing docs read as undefined; no migration needed.
  emailResolver?: 'apollo' | 'email_finder' | 'scrape' | 'verifier' | 'none' | null;
  linkedinUrl: string | null;
  likelyEmailPattern: string | null;
  confidence: number | null;
  reasoning: string | null;
  status: 'suggested' | 'approved' | 'rejected' | 'contacted' | 'replied';
  source: 'web_search' | 'apollo' | 'csv' | 'manual';
  apolloPersonId: string | null;
  seniority: string | null;
  headline: string | null;
  location: string | null;
}

export interface EvidencePackDoc extends BaseDoc {
  targetId: string;
  missionId: string; // denormalized
  bullets: Array<{
    fact: string;
    sourceUrl: string;
    sourceTitle: string;
    signalType: string;
    recency: string;
  }>;
  citations: Array<{ url: string; title?: string }>;
  // Vector field — concatenated bullets, embedded with Voyage.
  embedding?: number[];
}

export interface EmailSequenceDoc extends BaseDoc {
  contactId: string;
  targetId: string;
  missionId: string;
  evidencePackId: string | null;
  primaryAngle: string | null;
  anchoredBullets: number[];
  subject: string;
  body: string;
  followups: Array<{ waitDays: number; subject: string; body: string }>;
  status: 'draft' | 'approved' | 'sent' | 'bounced' | 'replied' | 'archived';
  scheduledSendAt: Date | null;
  sentAt: Date | null;
  profileVersionId: string | null;
  // Vector field — embed subject+body so we can retrieve "past sequences that
  // got replies" as exemplars for new generations.
  embedding?: number[];
}

export interface SentMessageDoc extends BaseDoc {
  sequenceId: string;
  contactId: string;
  missionId: string;
  touchIndex: number;
  subject: string;
  body: string;
  toEmail: string;
  gmailDraftId: string | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  status: 'draft' | 'queued' | 'sent' | 'failed' | 'bounced';
  scheduledSendAt: Date | null;
  sentAt: Date | null;
  failedReason: string | null;
  profileVersionId: string | null;
  profileRefs: Array<{ field: string; snippet: string }>;
}

export interface ReplyDoc extends BaseDoc {
  contactId: string;
  sentMessageId: string | null;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  fromEmail: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  classification:
    | 'interested'
    | 'not_now'
    | 'wrong_person'
    | 'referral'
    | 'oof'
    | 'unsubscribe'
    | 'question'
    | 'other'
    | null;
  urgency: 'low' | 'normal' | 'high' | null;
  keyPoints: string[] | null;
  suggestedResponse: { subject: string; body: string } | null;
  recommendedAction: string | null;
  status: string;
  notes: string | null;
  handled: boolean;
  receivedAt: Date | null;
}

export interface AgentRunDoc extends BaseDoc {
  missionId: string | null;
  targetId: string | null;
  contactId: string | null;
  agentType:
    | 'targeting'
    | 'contacts'
    | 'evidence'
    | 'sequence'
    | 'reply'
    | 'enrich_profile'
    | 'coach'
    | 'parse_resume';
  status: 'running' | 'completed' | 'failed';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface UserIntegrationDoc extends BaseDoc {
  provider: 'gmail';
  providerAccountEmail: string | null;
  refreshTokenEncrypted: string;
  accessTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
  scopes: string;
  status: 'active' | 'revoked' | 'error';
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Pipeline runs — the durable, resumable record of a full mission pipeline.
//
// Replaces the old browser-driven orchestration (which died when the tab
// closed). The server advances this doc one step at a time; it IS the source of
// truth for progress, so any driver — in-process loop, a resumed poll, or a
// Cloud Tasks worker — can pick up exactly where the last one stopped.
// ---------------------------------------------------------------------------
export type PipelineStepStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PipelineTargetState {
  targetId: string;
  name: string;
  score: number | null;
  evidence: PipelineStepStatus;
  contacts: PipelineStepStatus;
  sequence: PipelineStepStatus;
  bestContactId: string | null;
}

export interface PipelineRunDoc extends BaseDoc {
  missionId: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'error' | 'canceled';
  phase: 'targeting' | 'processing' | 'done';
  config: { targetCount: number; topN: number };
  targets: PipelineTargetState[];
  // Resume pointer into `targets`. null before targeting completes / after done.
  cursor: { targetIndex: number; step: 'evidence' | 'contacts' | 'sequence' } | null;
  note: string | null;
  error: string | null;
  // Bumped on every persisted step; a stale heartbeat means the driver died and
  // the run is safe to resume.
  heartbeatAt: Date;
  startedAt: Date;
  completedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Index spec — read by scripts/init-mongo.ts. Plain JS so the script doesn't
// need to import any types.
// ---------------------------------------------------------------------------

export const INDEX_SPEC: Record<string, Array<{ keys: Record<string, 1 | -1>; options?: Record<string, unknown> }>> = {
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
  suppressions: [
    { keys: { userId: 1, email: 1 }, options: { unique: true } },
  ],
  pipeline_runs: [
    { keys: { userId: 1, missionId: 1, createdAt: -1 } },
    // Resume sweeper: find live runs whose driver has gone stale.
    { keys: { status: 1, heartbeatAt: 1 } },
    // TTL: drop finished run records after 30 days.
    { keys: { createdAt: 1 }, options: { expireAfterSeconds: 60 * 60 * 24 * 30 } },
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
