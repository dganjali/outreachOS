// MongoDB collection schemas - the single place that describes what every
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
//   userId: string         (Firebase UID - denormalized on every doc for O(1) ownership checks)
//   createdAt: Date
//   updatedAt: Date
// These are stamped by the `forUser(uid).collection().insertOne()` wrapper.

import type { EmbedInputType } from '../api/_lib/embeddings';
import type { PlanId, PlanStatus } from './plans';
import type { ContactIcp, FindMode, SectorSuggestion, SeniorityLevel } from './types';

void ({} as EmbedInputType); // keep the import live for downstream consumers

// ---------------------------------------------------------------------------
// Document shapes (TypeScript, not Mongo validators).
// We intentionally keep validators OFF for hackathon velocity - add later via
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
  linkedinSource: 'web_search' | null;
  onboardingStep: number;
  onboardingCompletedAt: Date | null;
  // Auto follow-up cadence. OFF by default: with send-only Gmail scope the app
  // can't see replies, so auto-sending follow-ups would keep nudging people who
  // already replied. Sending an initial email only schedules its follow-ups when
  // this is explicitly true; otherwise follow-ups are the user's manual choice.
  autoFollowups?: boolean;
  // Hard kill-switch: when true, the follow-up sweeper skips this user's
  // scheduled touches regardless of autoFollowups (legacy "pause" control).
  pauseFollowups?: boolean;

  // --- Billing / monetization (Stripe). All optional; absence == free tier. ---
  // The plan the user purchased. Effective limits also depend on planStatus -
  // see resolvePlan() in shared/plans.ts. Defaults to 'free' when unset.
  plan?: PlanId | null;
  planStatus?: PlanStatus | null;
  // Stripe identifiers. customerId is created on first checkout and reused.
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  // End of the current paid period (subscription renews/expires here).
  planRenewsAt?: Date | null;
  planUpdatedAt?: Date | null;
  // Monotonic monthly mission-launch counter, the source of truth for the
  // monthly cap. `period` is the UTC 'YYYY-MM' the count applies to; a new month
  // lazily resets `used` to 0. NEVER decremented on mission delete - counting
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
  kind: 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot' | 'context_dump';
  // Where this asset lives. 'person' (default) = memory bank, reused by every
  // mission. 'mission' = attached to one mission only (a campaign offer doc the
  // user chose not to add to the durable bank). Legacy docs read as 'person'.
  scope: 'person' | 'mission';
  missionId: string | null;  // set when scope==='mission'
  storagePath: string;       // GCS path (NOT a URL)
  fileName: string;
  fileSize: number;
  mimeType: string | null;
  parsedText: string | null;
  parsedFields: Record<string, unknown> | null;
  parsedAt: Date | null;
  parseError: string | null;
  sourceUrl: string | null;
  // Vector field - populated for resume chunks so the sequence agent can
  // semantically retrieve relevant snippets instead of stuffing the whole CV.
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// Personalization layer - the persona/taste model. Layered design:
//   • Person-level identity + shared proof live on ProfileDoc + ContextFacts
//     (scope:'person'), entered once and reused across personas.
//   • Each PersonaDoc is a reusable, use-case-scoped *voice* (selected/created
//     at mission creation) carrying its own StyleProfile + offer/audience and
//     its own ContextFacts (scope:'persona') + StyleExemplars.
// The StyleProfile is the structured taste model: the engine READS it at
// generation; the learning loop WRITES it (confidence-weighted). This is what
// makes personalization "memory", not a one-shot prompt blob.
// ---------------------------------------------------------------------------

export interface StyleDimension {
  // Normalized scalar (most dims 0..1; sentenceLenTarget is a word count).
  value: number;
  // 0..1 - how trustworthy this value is. The learning-loop merge refuses to
  // overwrite a high-confidence dimension with a single noisy signal.
  confidence: number;
  // Where the value came from: 'onboarding' | 'edit-delta' | 'chat-instruction'
  // | 'reply-win' | 'manual' | 'default'.
  source: string;
}

export interface StyleProfile {
  // Structured voice/taste dimensions: formality, warmth, sentenceLenTarget,
  // hedging, emoji, jargon, directness, ctaStyle, ...
  dimensions: Record<string, StyleDimension>;
  // Extracted hard do/don'ts (e.g. "first paragraph ≤ 2 sentences").
  rules: Array<{ rule: string; source: string; confidence: number }>;
  // The user's PERSONAL slop list - hard constraints + critique input.
  bannedPhrases: string[];
  // Short prose summary regenerated from the above, injected into the prompt.
  voiceSummary: string;
  // Learned subject-line preference - a short directive describing how the
  // sender likes subjects (length, casing, punctuation, style). Captured from
  // the subject the user confirms/edits during calibration and applied to every
  // generated draft so the subjects that actually get SENT match their format.
  subjectStyle?: string;
  // How closely the generator should hug the persona's exemplar emails as a
  // template: 0 = loose inspiration (borrow only the voice), 100 = follow the
  // structure/phrasing of the closest exemplar almost verbatim. User-set via the
  // Style step slider; the engine turns it into an explicit drafting directive.
  templateStrictness: number;
}

/** A fresh, empty StyleProfile (persona v1 before any calibration). */
export function emptyStyleProfile(): StyleProfile {
  return { dimensions: {}, rules: [], bannedPhrases: [], voiceSummary: '', subjectStyle: '', templateStrictness: DEFAULT_TEMPLATE_STRICTNESS };
}

/** Mid-scale default: lean on the exemplar voice without copying its structure. */
export const DEFAULT_TEMPLATE_STRICTNESS = 50;

export interface PersonaDoc extends BaseDoc {
  name: string;                          // "Sponsorship voice", "Recruiting voice"
  mode: MissionDoc['mode'] | null;
  // DEPRECATED: a voice is now purely email style (styleProfile + exemplars).
  // Offer/audience live on the MISSION. These fields stay nullable for back-compat
  // with old docs; nothing new reads or writes them.
  offer?: string | null;
  audience?: string | null;
  styleProfile: StyleProfile;            // embedded current version
  styleProfileVersion: number;           // monotonically increments on each calibration
  onboardingCompletedAt: Date | null;
  archivedAt: Date | null;
  // Person-level (default) context facts this voice has opted OUT of. Person
  // facts apply to every persona by default; listing an id here hides it from
  // this voice's display AND its generation grounding, without deleting the
  // fact globally (it stays available to other voices).
  excludedFactIds?: string[];
}

// Immutable per-calibration snapshots - audit + rollback for a persona's voice.
export interface PersonaVersionDoc extends BaseDoc {
  personaId: string;
  snapshot: Record<string, unknown>;     // a StyleProfile at a point in time
  source: 'onboarding' | 'edit-delta' | 'chat-instruction' | 'reply-win' | 'manual' | 'restore';
  version: number;
}

// Atomic, citable substance = the "allowed facts" universe the grounding
// contract draws from. The generator may only assert facts that appear here.
export interface ContextFactDoc extends BaseDoc {
  // 'person'  = memory bank: durable proof about the sender, reused by every mission.
  // 'mission' = campaign substance: offer/audience/proof scoped to one mission.
  // 'persona' = LEGACY (voice-owned facts). Nothing new writes this; the migration
  //             re-scopes existing persona facts to 'person'. Kept in the union so
  //             old docs still parse until the migration runs.
  scope: 'person' | 'mission' | 'persona';
  missionId: string | null;              // set when scope==='mission'
  personaId: string | null;              // LEGACY: set on old scope==='persona' docs
  type: 'proof' | 'metric' | 'offer' | 'audience' | 'credential' | 'constraint';
  claim: string;                         // atomic, self-contained
  date: string | null;                   // recency/decay
  evidenceUrl: string | null;
  provenance: 'resume' | 'dictation' | 'answer' | 'manual' | 'enrich';
  confidence: number;
  embedding?: number[];                  // context_fact_vector_idx (relevance retrieval)
  // Generalizes coach.ts per-field stats to per-fact: which facts get replies.
  replyStats?: { sent: number; replied: number };
}

// Gold-standard emails as first-class objects (replaces the exampleEmails blob).
// Carry the persona's voice for few-shot retrieval; works at cold-start because
// they're user-provided, then earned winners accrue over time.
export interface StyleExemplarDoc extends BaseDoc {
  personaId: string;
  subject: string | null;
  body: string;
  mode: MissionDoc['mode'] | null;
  source: 'user-provided' | 'stage4-confirmed' | 'earned-winner';
  outcome: 'replied' | 'unknown';
  embedding?: number[];                  // style_exemplar_vector_idx (filter userId, personaId)
}

export interface MissionDoc extends BaseDoc {
  name: string;
  goal: string;
  targetDescription: string;
  mode: 'sponsorship' | 'bd' | 'internship' | 'recruiting' | 'sales';
  // What this mission hunts for. Absent ⇒ 'companies' (the original company-first
  // flow). 'people' finds specific people directly and seeds one pipeline target
  // per person (their company carried as context for research/drafting).
  findMode?: FindMode | null;
  offerDetails: string | null;
  // Optional location focus (region/country/city) for contact discovery. null =
  // no geographic preference. See CONTACT_ENGINE.md §4.
  geo?: string | null;
  // Free-text notes the user keeps on the mission (context, status reminders,
  // targeting caveats). Optional so pre-notes missions read as undefined.
  notes?: string | null;
  // Cached Ideal Contact Profile - generated once on first contact discovery and
  // reused across this mission's targets (CONTACT_ENGINE.md §2/§8). Optional so
  // pre-engine missions read as undefined; lazily backfilled on next run.
  contactIcp?: ContactIcp | null;
  // Cached AI-suggested company sectors for targeting - generated once on first
  // launch and reused. Optional so pre-sector missions read as undefined.
  sectorSuggestions?: SectorSuggestion[] | null;
  status: string;
  archivedAt: Date | null;
  // The persona (reusable voice) this mission drafts as. Required for new
  // missions; null on pre-personalization missions until backfilled.
  personaId: string | null;
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
  source: 'web_search' | 'csv' | 'manual';
  industry: string | null;
  employeeCount: number | null;
  headquartersLocation: string | null;
  // People-mode only: the specific person this target was discovered FOR. When
  // present, the contacts agent skips fresh discovery and resolves THIS person's
  // email instead. Absent on company-mode targets.
  seedContact?: {
    name: string;
    role: string | null;
    linkedinUrl: string | null;
    location: string | null;
    headline: string | null;
    confidence: number | null;
  } | null;
}

export interface ContactDoc extends BaseDoc {
  targetId: string;
  missionId: string; // denormalized for ownership filter
  name: string;
  role: string;
  email: string | null;
  emailStatus: 'verified' | 'likely' | 'guessed' | 'none';
  // Which rung of the resolution cascade produced the email (analytics only).
  // Optional - pre-existing docs read as undefined; no migration needed.
  emailResolver?: 'preexisting' | 'email_finder' | 'scrape' | 'verifier' | 'none' | null;
  linkedinUrl: string | null;
  likelyEmailPattern: string | null;
  confidence: number | null;
  reasoning: string | null;
  status: 'suggested' | 'approved' | 'rejected' | 'contacted' | 'replied';
  source: 'web_search' | 'csv' | 'manual';
  seniority: string | null;
  headline: string | null;
  location: string | null;
  // Per-recipient verification (api/_lib/contact-verify.ts). Confirms THIS
  // specific person actually matches the mission's hard requirement (current
  // affiliation, the right role, not a former/graduated/wrong-team person)
  // BEFORE we draft and send. A 'mismatch' contact is dropped, never surfaced -
  // so this only ever rides on contacts we kept. unset/null ⇒ not verified
  // (legacy docs, or verification disabled).
  verification?: {
    verdict: 'match' | 'weak' | 'mismatch';
    confidence: number; // 0..1
    reason: string;
    checkedAt: Date;
  } | null;
  // Individualized research about THIS person, gathered during verification and
  // surfaced to the draft as recipient signals (assemble.ts) so the email
  // references the human, not just their employer. Sourced facts only.
  personResearch?: Array<{
    fact: string;
    sourceUrl: string | null;
    sourceTitle: string | null;
  }> | null;
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
    // Whether sourceUrl was confirmed to resolve to a live page at build time.
    // true = verified live; false = checked and dead/unreachable (likely a
    // fabricated link); undefined = not checked (legacy/manual bullets).
    linkOk?: boolean;
  }>;
  citations: Array<{ url: string; title?: string }>;
  // Vector field - concatenated bullets, embedded with Voyage.
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
  // Immutable record of the INITIAL email exactly as the AI first produced it.
  // The learning loop compares this against the human-edited final (the
  // edit-delta) - the richest taste signal. Optional: pre-personalization docs
  // read as undefined; never overwritten once set (saveTouch updates only
  // subject/body).
  originalSubject?: string | null;
  originalBody?: string | null;
  followups: Array<{ waitDays: number; subject: string; body: string; disabled?: boolean }>;
  status: 'draft' | 'approved' | 'sent' | 'bounced' | 'replied' | 'archived';
  // Campaign Autopilot verdict for this draft. unset/null ⇒ the gate hasn't seen
  // it. 'review' = failed the gate (held for a human); 'ready' = passed but the
  // policy isn't auto-sending (awaiting 1-click approval); 'queued' = passed and
  // a scheduled send row has been created. Keeps the autopilot cron idempotent.
  autopilotState?: 'ready' | 'review' | 'queued' | null;
  // Cached LLM content-moderation verdict (api/_lib/content-moderation.ts),
  // keyed by contentHash so we only re-judge when subject/body changes.
  moderation?: { allowed: boolean; category: string | null; contentHash: string; checkedAt: Date } | null;
  scheduledSendAt: Date | null;
  sentAt: Date | null;
  profileVersionId: string | null;
  // Vector field - embed subject+body so we can retrieve "past sequences that
  // got replies" as exemplars for new generations.
  embedding?: number[];
}

export interface SentMessageDoc extends BaseDoc {
  sequenceId: string;
  contactId: string;
  missionId: string;
  touchIndex: number;
  subject: string; // the FINAL text actually sent (post human edit)
  body: string;
  // The AI's original draft for this touch, captured at send so the edit-delta
  // (draft → final) is preserved per message. Optional on legacy rows.
  draftSubject?: string | null;
  draftBody?: string | null;
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
  // Whether to attach the sender's résumé when this touch is actually sent.
  // Set for queued/scheduled sends so the cron knows to re-attach at send time
  // (the bytes aren't persisted on the row - only the intent). Optional/legacy.
  attachResume?: boolean;
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
    | 'parse_resume'
    | 'draft'
    | 'onboard_questions'
    | 'refine'
    | 'extract_style'
    | 'extract_context';
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
  // Sender-domain authentication health, checked at connect (api/_lib/dns-auth.ts).
  // 'gmail' ⇒ a @gmail.com address (Google-authenticated, nothing to configure).
  deliverability?: {
    domainAuth: 'gmail' | 'ok' | 'partial' | 'missing';
    spf: boolean;
    dkim: boolean;
    dmarc: boolean;
    checkedAt: Date;
  } | null;
}

// ---------------------------------------------------------------------------
// Pipeline runs - the durable, resumable record of a full mission pipeline.
//
// Replaces the old browser-driven orchestration (which died when the tab
// closed). The server processes targets in parallel and records each target's
// per-step status here; this doc IS the source of truth for progress, so any
// driver - in-process loop, a resumed poll, or a Cloud Tasks worker - can pick up
// exactly where the last one stopped (each step keys off its target's status, so
// resuming is idempotent).
// ---------------------------------------------------------------------------
export type PipelineStepStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PipelineTargetState {
  targetId: string;
  name: string;
  score: number | null;
  evidence: PipelineStepStatus;
  contacts: PipelineStepStatus;
  // Aggregate draft status for the target: 'done' once at least one contact has
  // a draft, 'failed' if none could be drafted. Per-contact detail lives in
  // `sequences` (parallel to `contactIds`).
  sequence: PipelineStepStatus;
  // The contacts we draft for, top `config.topContacts` by reply-likelihood.
  contactIds: string[];
  sequences: PipelineStepStatus[];
  // Primary contact (contactIds[0]); kept for convenience/back-compat.
  bestContactId: string | null;
}

export interface PipelineRunMetrics {
  /** First time any initial draft finished for this run. */
  firstDraftAt?: Date | null;
  /** Wall-clock time spent in the initial targeting call. */
  targetingMs?: number;
  /** Wall-clock time spent processing targets, including bounded parallel work. */
  processingMs?: number;
  /** Wall-clock time spent selecting/discovering replacement targets. */
  replacementMs?: number;
  /** End-to-end wall-clock time from run start to terminal completion. */
  totalMs?: number;
  /** Cumulative observed duration by agent type, measured around pipeline calls. */
  agentMs?: Partial<Record<AgentRunDoc['agentType'], number>>;
  /** Count of agent calls made by this pipeline driver, by agent type. */
  agentCalls?: Partial<Record<AgentRunDoc['agentType'], number>>;
}

export interface PipelineRunDoc extends BaseDoc {
  missionId: string;
  status: 'pending' | 'running' | 'paused' | 'done' | 'error' | 'canceled';
  phase: 'targeting' | 'processing' | 'done';
  config: {
    targetCount: number;
    topN: number;
    topContacts: number;
    // Mirrors the mission's find mode at launch time. Absent ⇒ 'companies'.
    findMode?: FindMode;
    // User-selected contact-type filters. Empty/absent ⇒ unfiltered ICP (the
    // AI-only default). Narrowed into the ICP at discovery time.
    selectedFunctions?: string[];
    selectedSeniority?: SeniorityLevel[];
    // User-selected company sectors to bias targeting toward (strong preference,
    // not a hard filter). Empty/absent ⇒ no sector bias.
    selectedSectors?: string[];
  };
  targets: PipelineTargetState[];
  // Legacy resume pointer. Processing now runs targets in parallel and tracks
  // progress via each target's per-step status (below), so this stays null during
  // parallel processing. Kept optional for back-compat / no migration; the union
  // still admits values older/remote runs may carry ('research' = evidence+contacts).
  cursor: { targetIndex: number; step: 'research' | 'evidence' | 'contacts' | 'sequence'; contactIndex?: number } | null;
  note: string | null;
  error: string | null;
  // When status is 'paused' on the daily agent-run cap: the moment that rolling
  // 24h window frees up enough to resume (runs.ts:dailyResetAt). Null otherwise.
  // The client renders it in the user's local time instead of a vague "tomorrow".
  dailyResetAt?: Date | null;
  // Bumped on every persisted step; a stale heartbeat means the driver died and
  // the run is safe to resume.
  heartbeatAt: Date;
  metrics?: PipelineRunMetrics;
  startedAt: Date;
  completedAt: Date | null;
}

// Campaign Autopilot policy - one per mission. The "runs while I sleep" control
// surface: the autopilot cron (api/cron/autopilot-tick.ts) sources new targets on
// a cadence, applies the confidence gate to fresh drafts, and (when autoSend is on)
// queues sends within the daily cap + send window. Paid-tier only.
export interface CampaignPolicyDoc extends BaseDoc {
  missionId: string;
  enabled: boolean;
  // false ⇒ gate stages passing drafts as 'ready' for 1-click approval rather
  // than auto-queuing them. Default false (opt into full autonomy).
  autoSend: boolean;
  // --- sourcing cadence ---
  targetsPerCycle: number; // new companies per sourcing run
  cycleIntervalHours: number; // min hours between sourcing runs
  lastSourcedAt: Date | null;
  // --- sending guardrails ---
  dailySendCap: number; // max auto-sends per day
  sendWindow: { startHour: number; endHour: number }; // local hours, [start,end)
  timezone: string; // IANA tz the send window is evaluated in
  // --- confidence gate ---
  minConfidence: number; // contact.confidence threshold, 0–1
  // Daily auto-send counter; `date` is the UTC 'YYYY-MM-DD' it applies to.
  counter: { date: string; sent: number } | null;
}

// ---------------------------------------------------------------------------
// Index spec - read by scripts/init-mongo.ts. Plain JS so the script doesn't
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
  ],
  contacts: [
    { keys: { userId: 1, targetId: 1, status: 1 } },
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
  campaign_policies: [
    // One policy per mission (and the lookup the UI/cron use).
    { keys: { userId: 1, missionId: 1 }, options: { unique: true } },
    // Cron sweep: all enabled policies, oldest-sourced first.
    { keys: { enabled: 1, lastSourcedAt: 1 } },
  ],
  personas: [
    { keys: { userId: 1, createdAt: -1 } },
    { keys: { userId: 1, archivedAt: 1 } },
  ],
  persona_versions: [
    { keys: { userId: 1, personaId: 1, version: -1 } },
  ],
  context_facts: [
    { keys: { userId: 1, scope: 1, missionId: 1 } },
    // Legacy lookup for persona-scoped facts (read by the migration).
    { keys: { userId: 1, scope: 1, personaId: 1 } },
  ],
  style_exemplars: [
    { keys: { userId: 1, personaId: 1, createdAt: -1 } },
  ],
};

/**
 * Atlas Vector Search index definitions. These can't be created via the Node
 * driver's regular createIndex - they go through the Atlas Admin API or the
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
  {
    // Gold exemplar retrieval - the engine pulls the persona's most relevant
    // past emails as few-shot voice anchors. Cold-start works because exemplars
    // are user-provided at onboarding (not dependent on earned replies).
    collection: 'style_exemplars',
    name: 'style_exemplar_vector_idx',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
        { type: 'filter', path: 'userId' },
        { type: 'filter', path: 'personaId' },
      ],
    },
  },
  {
    // Relevance retrieval over the context bank - select the facts worth citing
    // for a given target instead of dumping the whole bank into the prompt.
    collection: 'context_facts',
    name: 'context_fact_vector_idx',
    definition: {
      fields: [
        { type: 'vector', path: 'embedding', numDimensions: 1024, similarity: 'cosine' },
        { type: 'filter', path: 'userId' },
        { type: 'filter', path: 'scope' },
        { type: 'filter', path: 'missionId' },
        { type: 'filter', path: 'personaId' },
      ],
    },
  },
];
