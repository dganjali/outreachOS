export type OnboardingStep = 1 | 2 | 3 | 4;

export type MissionMode = 'sponsorship' | 'bd' | 'internship' | 'recruiting' | 'sales';

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

export type TargetStatus = 'suggested' | 'approved' | 'rejected' | 'contacted';
export type TargetSource = 'web_search' | 'apollo' | 'csv' | 'manual';

export interface Target {
  id: string;
  mission_id: string;
  company_name: string;
  domain: string | null;
  score: number | null;
  why_now: string | null;
  fit_reason: string | null;
  signal_type: string | null;
  status: TargetStatus;
  source: TargetSource;
  apollo_organization_id: string | null;
  industry: string | null;
  employee_count: number | null;
  headquarters_location: string | null;
  created_at: string;
}

export type ContactStatus = 'suggested' | 'approved' | 'rejected' | 'contacted' | 'replied';
export type ContactSource = 'web_search' | 'apollo' | 'csv' | 'manual';
export type EmailStatus = 'verified' | 'likely' | 'guessed' | 'none';

export interface Contact {
  id: string;
  target_id: string;
  name: string;
  role: string;
  email: string | null;
  email_status: EmailStatus;
  linkedin_url: string | null;
  likely_email_pattern: string | null;
  confidence: number | null;
  reasoning: string | null;
  status: ContactStatus;
  source: ContactSource;
  apollo_person_id: string | null;
  seniority: string | null;
  headline: string | null;
  location: string | null;
  created_at: string;
}

export interface EvidenceBullet {
  fact: string;
  source_url: string;
  source_title: string;
  signal_type: string;
  recency: string;
}

export interface EvidencePack {
  id: string;
  target_id: string;
  bullets: EvidenceBullet[];
  citations: Array<{ url: string; title?: string }>;
  created_at: string;
}

export type SequenceStatus = 'draft' | 'approved' | 'sent' | 'bounced' | 'replied' | 'archived';

export interface EmailSequence {
  id: string;
  contact_id: string;
  target_id: string;
  mission_id: string;
  evidence_pack_id: string | null;
  primary_angle: string | null;
  anchored_bullets: number[];
  subject: string;
  body: string;
  followups: Array<{ wait_days: number; subject: string; body: string }>;
  status: SequenceStatus;
  scheduled_send_at: string | null;
  sent_at: string | null;
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

export type AgentType = 'targeting' | 'contacts' | 'evidence' | 'sequence' | 'reply' | 'enrich_profile';
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
