// Shared type definitions used by both the React client (src/) and the
// Vercel serverless functions (api/). Keep this file dependency-free.

export type MissionMode = 'sponsorship' | 'bd' | 'internship' | 'recruiting' | 'sales';

// ---------------------------------------------------------------------------
// Contact Discovery Engine — see CONTACT_ENGINE.md. Defined in this
// dependency-free module so both the api/ engine and the React client share one
// source of truth for the seniority taxonomy and the Ideal Contact Profile.
// ---------------------------------------------------------------------------

// Normalized seniority ladder, junior → senior. Rank values live in
// api/_lib/seniority.ts (SENIORITY_RANK); this is just the closed vocabulary.
export type SeniorityLevel =
  | 'ic'
  | 'senior_ic'
  | 'lead'
  | 'manager'
  | 'senior_manager'
  | 'director'
  | 'senior_director'
  | 'vp'
  | 'svp'
  | 'cxo'
  | 'founder';

// Company-size tier. The acceptable seniority band shifts with this so the same
// mission targets a startup's CMO but an enterprise's program manager.
export type SizeTier = 'startup' | 'small' | 'mid' | 'large' | 'enterprise';

export type GeoScope = 'metro' | 'country' | 'region' | 'global';

export interface ContactIcpGeo {
  preferred: string | null; // human label, e.g. "Toronto, CA" — null = anywhere
  scope: GeoScope;
  strict: boolean; // true = drop out-of-geo contacts; false = only down-rank them
}

// The adaptive spec of WHO to reach at a target. Generated per mission, adapted
// per target. Drives query construction, hard filtering, and ranking.
export interface ContactIcp {
  functions: string[]; // semantic target functions (e.g. "community investment")
  functionKeywords: string[]; // expanded query synonyms
  seniority: {
    idealLevels: SeniorityLevel[];
    maxLevel: SeniorityLevel; // hard cap before per-target size shift
  };
  disqualifierKeywords: string[]; // title substrings that hard-drop a candidate
  routerOk: boolean; // accept gatekeepers/routers (coordinators, EAs)?
  geo: ContactIcpGeo;
  rationale: string; // one line: why this band for this mission
}

export type TargetStatus = 'suggested' | 'approved' | 'rejected' | 'contacted';
export type TargetSource = 'web_search' | 'csv' | 'manual';

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
  industry: string | null;
  employee_count: number | null;
  headquarters_location: string | null;
  created_at: string;
}

export type ContactStatus = 'suggested' | 'approved' | 'rejected' | 'contacted' | 'replied';
export type ContactSource = 'web_search' | 'csv' | 'manual';
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
