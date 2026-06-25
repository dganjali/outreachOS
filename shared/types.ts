// Shared type definitions used by both the React client (src/) and the
// Vercel serverless functions (api/). Keep this file dependency-free.

export type MissionMode = 'sponsorship' | 'bd' | 'internship' | 'recruiting' | 'sales';

// ---------------------------------------------------------------------------
// Contact Discovery Engine - see CONTACT_ENGINE.md. Defined in this
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
  preferred: string | null; // human label, e.g. "Toronto, CA" - null = anywhere
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

// A single "type of person to reach out to" the user can toggle on/off before a
// run. Derived from the mission's ICP (functions × seniority band) so the AI
// proposes the menu and the human narrows it instead of the AI guessing alone.
export interface ContactTypeOption {
  id: string; // stable, e.g. "fn:community" | "sen:director" | "sector:fintech"
  kind: 'function' | 'seniority' | 'sector';
  label: string; // human-friendly, e.g. "Community" | "Director" | "Fintech"
  value: string; // raw value: a function string, a SeniorityLevel, or a sector name
  recommended: boolean; // pre-checked = part of the AI's own suggested set
}

// AI-suggested company sector/industry for a mission's targeting. Cached on the
// mission and surfaced as `kind: 'sector'` options so the user can bias WHICH
// companies the targeting agent goes after (a strong preference, not a hard filter).
export interface SectorSuggestion {
  name: string; // short noun phrase, e.g. "developer tools", "fintech"
  recommended: boolean; // the AI's strongest fits, pre-checked in the UI
}

// The user's selection, threaded into discovery to narrow the ICP. Empty/absent
// fields mean "no narrowing" so the run behaves exactly as the AI-only default.
export interface ContactTypeFilter {
  functions?: string[]; // ICP function values the user kept
  seniority?: SeniorityLevel[]; // SeniorityLevel values the user kept
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

export type AutopilotState = 'ready' | 'review' | 'queued';

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
  followups: Array<{ wait_days: number; subject: string; body: string; disabled?: boolean }>;
  status: SequenceStatus;
  // Campaign Autopilot verdict (see CampaignPolicyDoc.autopilotState).
  autopilot_state?: AutopilotState | null;
  scheduled_send_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

// Campaign Autopilot policy (one per mission) - frontend (snake_case) mirror of
// CampaignPolicyDoc. The db shim maps to/from camelCase automatically.
export interface CampaignPolicy {
  id: string;
  mission_id: string;
  enabled: boolean;
  auto_send: boolean;
  targets_per_cycle: number;
  cycle_interval_hours: number;
  last_sourced_at: string | null;
  daily_send_cap: number;
  send_window: { start_hour: number; end_hour: number };
  timezone: string;
  min_confidence: number;
  counter: { date: string; sent: number } | null;
  created_at: string;
  updated_at: string;
}
