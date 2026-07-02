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
  // When true, discovery may surface a company already approved/contacted in
  // another mission. Default (absent/false): companies never repeat across
  // missions - see loadCommittedDomains in api/_lib/targeted.ts.
  allowRepeatCompanies?: boolean;

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
  // 'mission_attachment' is a pure email attachment (a deck, one-pager, résumé
  // copy) sent with every email in a mission. It is NOT parsed/embedded and never
  // feeds drafting - it only rides along on the wire.
  kind: 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot' | 'context_dump' | 'mission_attachment';
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
  // Optional profile_assets id (kind 'mission_attachment') attached to EVERY
  // email sent for this mission - a deck, one-pager, or résumé the user wants on
  // all outreach. null/absent = no attachment.
  attachAssetId?: string | null;
  // Free-text standing instructions injected into EVERY draft for this mission
  // ("always mention I built X", "never lead on price"). Distinct from `notes`,
  // which is private and never reaches the writer. null/absent = none.
  draftDirective?: string | null;
  // Context-fact ids (person- or mission-scope) the user pinned to always feature
  // in this mission's drafts. They bypass the relevance cap in assemble.ts and the
  // writer is told to work one in. Mirrors PersonaDoc.excludedFactIds.
  emphasizedFactIds?: string[];
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
  // The mission's "attach to every email" asset (a profile_assets id), captured
  // at send so a queued/scheduled touch re-attaches the right file at send time
  // even if the mission setting later changes. Optional/legacy.
  attachAssetId?: string | null;
}

// Global per-account "already contacted" ledger. One row per person this user
// has sent (or queued) an INITIAL email to, across ALL missions - permanent
// cross-mission dedup so a person enters the account's outreach exactly once
// ever. The per-mission guards still run for re-sourcing; this is the wider net.
// Survives target/mission deletion, like sent history.
export interface ContactLedgerDoc extends BaseDoc {
  emailKey: string | null; // lower-cased email, when known
  identityKey: string; // `${linkedinUrl}|${name}` lower-cased (the contactKey shape)
  firstContactedAt: Date;
  missionId: string; // first mission that reached them (provenance only)
}

// Platform-wide, ANONYMIZED outreach-pressure tally. `_id` is a salted hash of a
// contact identity (email or linkedin/name) - not reversible to a person and not
// tied to any account - so ranking can spread load across the whole platform
// (stop every account hammering the same popular profiles) without sharing who
// contacted whom. NOT a BaseDoc: no userId, accessed via adminDb only. See
// api/_lib/contacted.ts.
export interface ContactHeatDoc {
  _id: string; // salted hash of the identity key
  sends: number; // total initial emails across ALL accounts
  lastContactedAt: Date;
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
    | 'extract_context'
    | 'steer';
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

// LEGACY (Phase 3): superseded by MissionRecipeDoc, which subsumes these fields
// into its send + verification stages. Nothing WRITES this collection anymore;
// it is only READ as a migration fallback by recipe.ts:resolveRecipe for missions
// that predate the recipe backfill (scripts/migrate-recipes.ts). Safe to drop the
// collection + this type once the migration has run in production and been
// verified. Kept meanwhile so un-migrated missions keep their exact settings.
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
// Mission Recipe (Phase 3) - the modular pipeline definition, one per mission.
// The SINGLE source of truth both manual runs (api/agents/pipeline.ts) and the
// autopilot cron (api/cron/autopilot-tick.ts) read, so the two can no longer
// drift. Stages map 1:1 onto the pipeline executors and onto the product's
// mermaid: sourcing -> verification -> research -> personSourcing ->
// sequencing -> send. Stages are enable/disable + configure, not reorderable
// (the pipeline is inherently sequential), so they are named fields, not a list.
//
// This SUBSUMES the old CampaignPolicyDoc: the `send` stage carries the
// automation cadence, sending guardrails, and operational counters that used to
// live on the policy doc. `automationEnabled` is the autopilot master switch.
// Field names in the send/verification stages match the old policy fields so the
// pure logic in api/_lib/autopilot.ts is reused unchanged via a `SendPolicy`
// structural view (see api/_lib/recipe.ts:policyView).
// ---------------------------------------------------------------------------

export type RecipeStageType =
  | 'sourcing'
  | 'verification'
  | 'research'
  | 'personSourcing'
  | 'sequencing'
  | 'send';

// WHO to contact: discover targets (companies, or people directly in people mode).
export interface SourcingStage {
  type: 'sourcing';
  enabled: boolean; // false ⇒ pursue existing targets only, discover no new ones
  provider: 'web_search' | 'csv' | 'manual';
  findMode: FindMode;
  count: number; // targets to discover per run (pipeline config.targetCount)
  topN: number; // how many discovered targets to actually pursue
  sectors: string[]; // sector bias, not a hard filter (config.selectedSectors)
}

// WHETHER a contact is reachable + a good fit: address resolution/verification
// and the per-recipient fit gate. minConfidence is also the send gate's floor.
export interface VerificationStage {
  type: 'verification';
  enabled: boolean;
  emailVerify: boolean; // resolve + verify the recipient address
  contactVerify: boolean; // per-recipient fit gate (see contact-verify.ts)
  minConfidence: number; // 0–1 confidence floor for auto-send
}

// PROOF to personalize with: evidence pack + company enrichment.
export interface ResearchStage {
  type: 'research';
  enabled: boolean; // false ⇒ skip evidence gathering (drafts run thinner)
  evidence: boolean;
  companyEnrich: boolean;
}

// WHICH person(s) at each company, and how many.
export interface PersonSourcingStage {
  type: 'personSourcing';
  enabled: boolean;
  contactsPerCompany: number; // pipeline config.topContacts
  functions: string[]; // ICP function values to prioritize (config.selectedFunctions)
  seniority: SeniorityLevel[]; // seniority levels to prioritize (config.selectedSeniority)
}

// HOW the outreach reads: number of touches (directive + pinned facts stay on
// the mission doc, which the drafter already reads everywhere).
export interface SequencingStage {
  type: 'sequencing';
  enabled: boolean;
  touches: number; // total email touches in the sequence (initial + follow-ups)
}

// WHEN + how fast to send. Carries the automation cadence + guardrails +
// operational counters formerly on CampaignPolicyDoc.
export interface SendStage {
  type: 'send';
  enabled: boolean;
  autoSend: boolean; // false ⇒ gate passes drafts as 'ready' for 1-click approval
  cycleIntervalHours: number; // min hours between sourcing runs
  dailySendCap: number; // max auto-sends per day
  sendWindow: { startHour: number; endHour: number }; // local hours, [start,end)
  timezone: string; // IANA tz the send window is evaluated in
  // --- operational state (moved off the old policy doc) ---
  lastSourcedAt: Date | null;
  counter: { date: string; sent: number } | null; // daily auto-send counter
}

export interface MissionRecipeDoc extends BaseDoc {
  missionId: string;
  // Autopilot master switch (was CampaignPolicyDoc.enabled). When true, the cron
  // runs this recipe automatically on the send stage's cadence. When false, the
  // same recipe still drives manual runs; it just isn't triggered automatically.
  automationEnabled: boolean;
  sourcing: SourcingStage;
  verification: VerificationStage;
  research: ResearchStage;
  personSourcing: PersonSourcingStage;
  sequencing: SequencingStage;
  send: SendStage;
}

// ---------------------------------------------------------------------------
// Autopilot steering chat. The steer agent (api/agents/steer.ts) turns one NL
// instruction ("go for bigger companies", "emphasize this fact") into a
// structured proposal over the mission's targeting/drafting/sending settings.
// The user reviews and confirms before anything is applied.
// ---------------------------------------------------------------------------

// One change the proposal would make, rendered as a row in the review card.
export interface SteerChange {
  label: string; // human-readable, e.g. "Daily send cap"
  from: string; // current value, stringified for display ("10")
  to: string; // proposed value ("25")
}

// The structured patch the steer agent proposes. Every field is optional; only
// what the instruction implies is set. `clarification` is the ambiguous/unsupported
// path - when present the agent is asking a question instead of proposing changes.
export interface SteerProposal {
  mission?: {
    goal?: string;
    targetDescription?: string;
    geo?: string | null;
    draftDirective?: string; // replace the standing directive
    draftDirectiveAppend?: string; // or append a line to it
    clearIcp?: boolean; // force ICP/sector regen on the next sourcing cycle
  };
  // A patch over the mission's recipe stages (the modular pipeline). Only the
  // stages/fields the instruction implies are set; applied + clamped server-side
  // via recipe.ts:applyRecipePatch. This is what lets the steering chat control
  // the WHOLE pipeline (contacts per company, seniority, evidence depth, cadence),
  // not just a fixed handful of settings.
  recipe?: {
    automationEnabled?: boolean;
    sourcing?: { enabled?: boolean; count?: number; topN?: number; sectors?: string[]; findMode?: FindMode };
    verification?: { enabled?: boolean; emailVerify?: boolean; contactVerify?: boolean; minConfidence?: number };
    research?: { enabled?: boolean; evidence?: boolean; companyEnrich?: boolean };
    personSourcing?: { enabled?: boolean; contactsPerCompany?: number; functions?: string[]; seniority?: SeniorityLevel[] };
    sequencing?: { enabled?: boolean; touches?: number };
    send?: {
      enabled?: boolean;
      autoSend?: boolean;
      dailySendCap?: number;
      cycleIntervalHours?: number;
      sendWindow?: { startHour: number; endHour: number };
      timezone?: string;
    };
  };
  emphasizeFactIds?: string[]; // pin these context-fact ids on the mission
  deemphasizeFactIds?: string[]; // unpin these
  // Direct edits to the discovered target set - "skim and truly edit the targets".
  // Ids come from the TARGETS list shown to the agent; names are free text.
  targets?: {
    add?: string[]; // company (people-mode: person/company) names to add as new targets
    removeIds?: string[]; // target ids to drop from the run (soft-reject)
    pinIds?: string[]; // target ids to keep + pursue (promote out of the suggested pool)
  };
  changes: SteerChange[]; // review-card rows describing the above
  clarification?: string | null; // set instead of a patch when the ask is unclear
}

// A single turn in a mission's steering chat. Assistant turns carry the proposal
// and its lifecycle so an un-applied proposal survives a reload.
export interface MissionSteeringDoc extends BaseDoc {
  missionId: string;
  role: 'user' | 'assistant';
  text: string; // the user's instruction, or the assistant's summary/clarification
  proposal?: SteerProposal | null;
  status?: 'proposed' | 'applied' | 'dismissed' | null; // assistant turns only
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
    // Covering scan for cross-mission company dedup (loadCommittedDomains):
    // filter by status, return domain only, no document fetch.
    { keys: { userId: 1, status: 1, domain: 1 } },
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
  contact_ledger: [
    // One ledger row per email per account (when an email is known)…
    { keys: { userId: 1, emailKey: 1 }, options: { unique: true, partialFilterExpression: { emailKey: { $type: 'string' } } } },
    // …and one per linkedin/name identity (always set), so email-less people dedup too.
    { keys: { userId: 1, identityKey: 1 }, options: { unique: true } },
  ],
  contact_heat: [
    // Lookup is by _id (the salted hash); this index is only for decay/cleanup scans.
    { keys: { lastContactedAt: 1 } },
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
  mission_recipes: [
    // One recipe per mission (the lookup the UI/pipeline/cron use).
    { keys: { userId: 1, missionId: 1 }, options: { unique: true } },
    // Cron sweep: all automation-enabled recipes, oldest-sourced first.
    { keys: { automationEnabled: 1, 'send.lastSourcedAt': 1 } },
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
  steering_messages: [
    // The chat panel loads one mission's turns in order.
    { keys: { userId: 1, missionId: 1, createdAt: 1 } },
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
