export type {
  MissionMode,
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
} from '../shared/types';
import type { MissionMode } from '../shared/types';
import type { PlanId, PlanStatus } from '../shared/plans';

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
  linkedin_source: 'apollo' | 'web_search' | null;
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
  offer_details: string | null;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Integration {
  provider: 'gmail';
  provider_account_email: string | null;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  updated_at: string;
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
  | 'parse_resume';

export type ProfileAssetKind = 'resume' | 'portfolio_pdf' | 'case_study' | 'screenshot';

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
