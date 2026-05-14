// Shared type definitions used by both the React client (src/) and the
// Vercel serverless functions (api/). Keep this file dependency-free.

export type MissionMode = 'sponsorship' | 'bd' | 'internship' | 'recruiting' | 'sales';

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
