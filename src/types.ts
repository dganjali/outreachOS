export type {
  MissionMode,
  FindMode,
  TargetStatus,
  TargetSource,
  Target,
  ContactStatus,
  ContactSource,
  EmailStatus,
  Contact,
  EvidenceBullet,
  EvidencePack,
  SequenceStatus,
  EmailSequence,
  AutopilotState,
  CampaignPolicy,
  SeniorityLevel,
  SizeTier,
  GeoScope,
  ContactIcp,
  ContactIcpGeo,
} from '../shared/types';
import type { MissionMode, FindMode } from '../shared/types';
import type { PlanId, PlanStatus } from '../shared/plans';
import type { SteerProposal } from '../shared/schemas';

export type { SteerProposal } from '../shared/schemas';

// One turn in a mission's autopilot steering chat (frontend mirror of
// MissionSteeringDoc, snake_cased by the data shim).
export interface MissionSteeringMessage {
  id: string;
  user_id: string;
  mission_id: string;
  role: 'user' | 'assistant';
  text: string;
  proposal?: SteerProposal | null;
  status?: 'proposed' | 'applied' | 'dismissed' | null;
  created_at: string;
}

export type OnboardingStep = 1 | 2 | 3 | 4;

export interface Profile {
  id: string;
  user_id: string;
  name: string | null;
  role: string | null;
  organization: string | null;
  bio: string | null;
  resume_url: string | null;
  linkedin_url: string | null;
  website: string | null;
  portfolio_links: string[] | null;
  proof_points: string | null;
  achievements: string | null;
  metrics: string | null;
  example_emails: string | null;
  writing_tone: string | null;
  linkedin_data: Record<string, unknown> | null;
  linkedin_enriched_at: string | null;
  linkedin_source: 'web_search' | null;
  onboarding_step: number;
  onboarding_completed_at: string | null;
  // Billing (Stripe). Absent == free tier.
  plan?: PlanId;
  plan_status?: PlanStatus;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  plan_renews_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Mission {
  id: string;
  user_id: string;
  name: string;
  goal: string;
  target_description: string;
  mode: MissionMode;
  // What this mission hunts for. Absent ⇒ 'companies' (the original flow).
  find_mode?: FindMode;
  offer_details: string | null;
  // Optional location focus (region/country/city) used to scope and rank
  // contact discovery. null = no geographic preference.
  geo: string | null;
  // Free-text notes the user keeps on the mission (context, status reminders
  // like "paused until August", targeting caveats). Editable from the brief card.
  notes?: string | null;
  status: string;
  archived_at: string | null;
  // The reusable persona (voice) this mission drafts as. Required for new
  // missions; null on pre-personalization missions until backfilled.
  persona_id: string | null;
  // Optional profile_assets id (kind 'mission_attachment') attached to every
  // email sent for this mission. null/absent = no attachment.
  attach_asset_id?: string | null;
  // Free-text standing instructions injected into every draft for this mission.
  // Distinct from `notes` (private, never drafted on). null/absent = none.
  draft_directive?: string | null;
  // Context-fact ids the user pinned to always feature in this mission's drafts.
  emphasized_fact_ids?: string[];
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Personalization layer (frontend mirrors of shared/schemas.ts, snake_cased by
// the api.ts response converter).
// ---------------------------------------------------------------------------
export interface StyleDimension {
  value: number;
  confidence: number;
  source: string;
}

export interface StyleProfile {
  dimensions: Record<string, StyleDimension>;
  rules: Array<{ rule: string; source: string; confidence: number }>;
  banned_phrases: string[];
  voice_summary: string;
  // 0 = loose voice inspiration, 100 = follow the closest exemplar verbatim.
  template_strictness: number;
}

export interface Persona {
  id: string;
  user_id?: string;
  name: string;
  mode: MissionMode | null;
  // DEPRECATED: a voice is now purely email style. Offer/audience live on the
  // mission. Kept optional for back-compat with pre-split personas.
  offer?: string | null;
  audience?: string | null;
  style_profile: StyleProfile;
  style_profile_version: number;
  onboarding_completed_at: string | null;
  archived_at: string | null;
  created_at?: string;
  // Person-level (default) fact ids this voice has opted out of - see PersonaDoc.
  excluded_fact_ids?: string[];
}

export interface ContextFact {
  id: string;
  // 'person' = memory bank (shared); 'mission' = this campaign's substance;
  // 'persona' = legacy voice-owned facts (migrated to 'person').
  scope: 'person' | 'mission' | 'persona';
  mission_id: string | null;
  persona_id: string | null;
  type: 'proof' | 'metric' | 'offer' | 'audience' | 'credential' | 'constraint';
  claim: string;
  date: string | null;
  evidence_url: string | null;
  provenance: string;
  confidence: number;
}

export interface StyleExemplar {
  id: string;
  persona_id: string;
  subject: string | null;
  body: string;
  mode: MissionMode | null;
  source: 'user-provided' | 'stage4-confirmed' | 'earned-winner';
  outcome: 'replied' | 'unknown';
}

export interface Integration {
  provider: 'gmail';
  provider_account_email: string | null;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  updated_at: string;
  deliverability?: {
    domainAuth: 'gmail' | 'ok' | 'partial' | 'missing';
    spf: boolean;
    dkim: boolean;
    dmarc: boolean;
    checkedAt: string;
  } | null;
}

export interface ProfileRef {
  field: 'bio' | 'proof_points' | 'achievements' | 'metrics' | 'writing_tone' | 'example_emails';
  snippet: string;
}

export interface SentMessage {
  id: string;
  user_id: string;
  sequence_id: string;
  contact_id: string;
  mission_id: string;
  touch_index: number;
  subject: string;
  body: string;
  to_email: string;
  gmail_draft_id: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  status: 'draft' | 'queued' | 'sent' | 'failed' | 'bounced';
  scheduled_send_at: string | null;
  sent_at: string | null;
  failed_reason: string | null;
  profile_version_id: string | null;
  profile_refs: ProfileRef[];
  attach_resume?: boolean;
  created_at: string;
}

export type ReplyClassification =
  | 'interested'
  | 'not_now'
  | 'wrong_person'
  | 'referral'
  | 'oof'
  | 'unsubscribe'
  | 'question'
  | 'other';

export interface Reply {
  id: string;
  user_id: string | null;
  contact_id: string;
  sent_message_id: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  from_email: string | null;
  subject: string | null;
  body: string | null;
  snippet: string | null;
  classification: ReplyClassification | null;
  urgency: 'low' | 'normal' | 'high' | null;
  key_points: string[] | null;
  suggested_response: { subject: string; body: string } | null;
  recommended_action: string | null;
  status: string;
  notes: string | null;
  handled: boolean;
  received_at: string | null;
  created_at: string;
}

export type ProfileVersionSource = 'manual' | 'enrich' | 'coach' | 'import' | 'restore';

export interface ProfileVersion {
  id: string;
  user_id: string;
  snapshot: Record<string, unknown>;
  source: ProfileVersionSource;
  label: string | null;
  created_at: string;
}

export type AgentType =
  | 'targeting'
  | 'contacts'
  | 'evidence'
  | 'sequence'
  | 'reply'
  | 'enrich_profile'
  | 'coach'
  | 'parse_resume'
  | 'extract_context';

export type ProfileAssetKind = 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot' | 'context_dump' | 'mission_attachment';

export interface ParsedResumeRole {
  title: string;
  organization: string;
  start: string;
  end: string;
  summary: string;
}

export interface ParsedResumeFields {
  headline?: string;
  bio?: string;
  proof_points?: string;
  achievements?: string;
  metrics?: string;
  writing_tone?: string;
  roles?: ParsedResumeRole[];
}

export interface ProfileAsset {
  id: string;
  user_id: string;
  kind: ProfileAssetKind;
  // 'person' (default) = memory bank; 'mission' = attached to one mission only.
  scope?: 'person' | 'mission';
  mission_id?: string | null;
  storage_path: string;
  file_name: string;
  file_size: number;
  mime_type: string | null;
  parsed_text: string | null;
  parsed_fields: ParsedResumeFields | null;
  parsed_at: string | null;
  parse_error: string | null;
  source_url: string | null;
  created_at: string;
}
export type RunStatus = 'running' | 'completed' | 'failed';

export interface AgentRun {
  id: string;
  user_id: string;
  mission_id: string | null;
  target_id: string | null;
  contact_id: string | null;
  agent_type: AgentType;
  status: RunStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

// Legacy types kept for backwards compatibility with existing pages
export interface EmailDraft {
  id: string;
  contact_id: string;
  subject: string;
  body: string;
  status: string;
  created_at: string;
}

export interface Reply {
  id: string;
  contact_id: string;
  status: string;
  notes: string | null;
  created_at: string;
}
