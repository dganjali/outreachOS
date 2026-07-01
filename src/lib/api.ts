// API client for our /api/agents/* + /api/gmail/* endpoints.
// Updated to attach a Firebase ID token instead of a Supabase access token.

import { currentIdToken } from '../firebaseClient';
import type {
  Target,
  Contact,
  EvidencePack,
  EmailSequence,
  AgentRun,
  AgentType,
  Integration,
  Profile,
  ReplyClassification,
  ParsedResumeFields,
  StyleProfile,
} from '../types';
import type { PlanId, PlanStatus } from '../../shared/plans';
import type { SteerProposal } from '../../shared/schemas';
// Mongo stores docs in camelCase + `_id`; frontend types use snake_case + `id`.
// Shared with src/lib/db.ts so the two clients can't drift.
import { toFrontend, readJson } from './caseMap';

async function authedFetch<T>(path: string, body: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const token = await currentIdToken();
  if (!token) throw new Error('Not signed in');
  const res = await fetch(path, {
    method,
    headers: {
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${token}`,
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const payload = await readJson<unknown>(res, 'Request failed');
  return toFrontend(payload) as T;
}

export const agents = {
  target: (mission_id: string, count?: number) =>
    authedFetch<{ run_id: string; targets: Target[]; source: 'web_search' }>('/api/agents/target', {
      mission_id,
      count,
    }),
  // People mode: discover people directly. Each returned target carries the
  // discovered person in `seedContact` (the contacts agent resolves their email).
  people: (mission_id: string, count?: number) =>
    authedFetch<{ run_id: string; targets: Target[]; source: 'people' }>('/api/agents/people', {
      mission_id,
      count,
    }),
  contacts: (target_id: string, top_contacts = 1) =>
    authedFetch<{ run_id: string; contacts: Contact[]; source: 'serper' | 'web_search' }>(
      '/api/agents/contacts',
      { target_id, top_contacts }
    ),
  evidence: (target_id: string) =>
    authedFetch<{ run_id: string; evidence_pack: EvidencePack }>('/api/agents/evidence', {
      target_id,
    }),
  sequence: (contact_id: string) =>
    authedFetch<{ run_id: string; sequence: EmailSequence }>('/api/agents/sequence', {
      contact_id,
    }),
  draft: (contact_id: string, tier?: 'onboarding' | 'bulk') =>
    authedFetch<{
      run_id: string;
      persona_id: string | null;
      draft: { angle: string; subject: string; body: string; claims: Array<{ text: string; factId: string }> };
      violations: Array<{ type: string; span: string; detail: string; severity: 'block' | 'warn' }>;
      voice_match_score: number;
      revisions: number;
      pass: boolean;
    }>('/api/agents/draft', { contact_id, tier }),
  // Onboarding calibration: run the engine once so the user iterates on a
  // genuine draft. Uses a real contact when one exists; otherwise synthesizes a
  // representative recipient (`synthetic: true`) so a draft always appears.
  // Calibrate a voice. Standalone: pass a `sample` {offer, audience} typed in the
  // wizard. Per-mission: pass `mission_id` to anchor on that mission's substance.
  calibrateDraft: (
    persona_id: string,
    opts?: { mission_id?: string; sample?: { offer?: string; audience?: string; geo?: string | null } }
  ) =>
    authedFetch<{
      run_id: string;
      recipient: { name: string; role: string; company: string };
      synthetic?: boolean;
      subject: string;
      body: string;
    }>('/api/agents/calibrate-draft', { persona_id, ...(opts ?? {}) }),
  onboardQuestions: (persona_id: string) =>
    authedFetch<{ run_id: string; questions: Array<{ id: string; question: string; why: string }> }>(
      '/api/agents/onboard-questions',
      { persona_id }
    ),
  refine: (input: { persona_id?: string; subject?: string; body: string; instruction: string; span?: string }) =>
    authedFetch<{ run_id: string; mode: 'span' | 'structural'; instruction: string; subject: string; body: string; note: string | null }>(
      '/api/agents/refine',
      input
    ),
  extractStyle: (input: {
    persona_id: string;
    chat_instructions?: string[];
    edit_deltas?: Array<{ original: string; final: string }>;
    confirmed_exemplar?: { subject?: string | null; body: string };
    source?: string;
  }) =>
    authedFetch<{
      run_id: string;
      persona_id: string;
      style_profile: StyleProfile;
      style_profile_version: number;
      exemplar_id: string | null;
    }>('/api/agents/extract-style', input),
  reply: (reply_id: string) =>
    authedFetch<{ run_id: string; classification: { classification: ReplyClassification; urgency: string; key_points: string[]; suggested_response: { subject: string; body: string } | null; recommended_action: string } }>(
      '/api/agents/reply',
      { reply_id }
    ),
  enrichProfile: () =>
    authedFetch<{
      run_id: string;
      profile: Profile;
      source: 'web_search';
      facts_added: number;
    }>('/api/agents/enrich-profile', {}),
  coach: (field: CoachField, current_value: string) =>
    authedFetch<{
      run_id: string;
      field: CoachField;
      suggestions: Array<{ title: string; rewrite: string; why: string }>;
      gaps: string[];
      outcomes: { sent_count: number; reply_count: number; reply_rate: number };
    }>('/api/agents/coach', { field, current_value }),
  parseResume: (asset_id: string) =>
    authedFetch<{ run_id: string; asset_id: string; parsed_fields: ParsedResumeFields }>(
      '/api/agents/parse-resume',
      { asset_id }
    ),
  // Extract facts from a doc/text into the memory bank ('person') or a mission.
  // Omit `destination` to let the server auto-route by document kind.
  extractContext: (input: {
    asset_id?: string;
    text?: string;
    mission_id?: string;
    destination?: 'person' | 'mission';
  }) =>
    authedFetch<{
      run_id: string;
      facts: Array<{ id: string; claim: string; type: string }>;
      document_kind: 'personal' | 'offer' | 'mixed';
      scope: 'person' | 'mission';
      mission_id: string | null;
    }>('/api/agents/extract-context', input),
  // Autopilot steering chat: interpret one instruction into a reviewable proposal.
  steer: (input: { mission_id: string; instruction: string }) =>
    authedFetch<{ run_id: string; summary: string; proposal: SteerProposal }>('/api/agents/steer', input),
  // Commit a proposal the user confirmed.
  steerApply: (input: { mission_id: string; proposal: SteerProposal }) =>
    authedFetch<{ ok: true; applied: Array<{ label: string; from: string; to: string }> }>(
      '/api/agents/steer/apply',
      input
    ),
  // Manual "cycle now": start a sourcing run immediately rather than waiting for
  // the hourly autopilot cron.
  autopilotRun: (mission_id: string) =>
    authedFetch<{ sourcing: 'started' | 'in_progress'; last_sourced_at?: string }>('/api/agents/autopilot/run', {
      mission_id,
    }),
};

export type CoachField =
  | 'bio'
  | 'proof_points'
  | 'achievements'
  | 'metrics'
  | 'writing_tone'
  | 'example_emails';

export const gmail = {
  start: () =>
    authedFetch<{ url: string }>('/api/integrations/gmail/start', { origin: window.location.origin }),
  status: () => authedFetch<{ connected: boolean; integration: Integration | null }>('/api/integrations/gmail/status', null, 'GET'),
  disconnect: () => authedFetch<{ disconnected: boolean }>('/api/integrations/gmail/disconnect', {}),
  send: (
    sequence_id: string,
    touch_index: number,
    mode: 'draft' | 'send',
    to_override?: string,
    // ISO 8601. When set, the touch is queued for the cron to send at that time
    // instead of going out now (mode is treated as 'send' once it fires).
    scheduled_send_at?: string,
    // Attach the sender's résumé to this touch.
    attach_resume?: boolean,
  ) =>
    authedFetch<{
      sent_message_id: string;
      mode: 'draft' | 'send' | 'scheduled';
      scheduled_send_at?: string | null;
      gmail_message_id: string;
      gmail_thread_id: string;
      gmail_draft_id?: string;
      warnings?: string[];
    }>('/api/gmail/send', { sequence_id, touch_index, mode, to_override, scheduled_send_at, attach_resume }),
  reply: (reply_id: string, subject: string, body: string) =>
    authedFetch<{ ok: boolean; gmail_message_id: string; gmail_thread_id: string }>('/api/gmail/reply', {
      reply_id,
      subject,
      body,
    }),
};

// ---------------------------------------------------------------------------
// Server-side durable pipeline. The client starts a run and polls its state;
// progress survives a closed tab because the server owns the run.
// ---------------------------------------------------------------------------
export type PipelineRunStatus = 'pending' | 'running' | 'paused' | 'done' | 'error' | 'canceled';
export type PipelineStep = 'evidence' | 'contacts' | 'sequence';
export type PipelineStepStatus = 'queued' | 'running' | 'done' | 'failed';

export interface PipelineTargetView {
  target_id: string;
  name: string;
  score: number | null;
  evidence: PipelineStepStatus;
  contacts: PipelineStepStatus;
  sequence: PipelineStepStatus;
  contact_ids: string[];
  sequences: PipelineStepStatus[];
  best_contact_id: string | null;
}

// A "type of person to reach out to" the user can toggle before a run. Mirrors
// the server's ContactTypeOption (authedFetch snake-cases keys, but these are
// already single-word/no-case so they arrive unchanged).
export interface ContactTypeOptionView {
  id: string;
  kind: 'function' | 'seniority' | 'sector';
  label: string;
  value: string;
  recommended: boolean;
}

export interface PipelineRunView {
  id: string;
  mission_id: string;
  status: PipelineRunStatus;
  phase: 'targeting' | 'processing' | 'done';
  note: string | null;
  error: string | null;
  config: {
    target_count: number;
    top_n: number;
    top_contacts: number;
    selected_functions?: string[];
    selected_seniority?: string[];
    selected_sectors?: string[];
  };
  cursor: { target_index: number; step: PipelineStep; contact_index?: number } | null;
  targets: PipelineTargetView[];
  started_at: string;
  completed_at: string | null;
  // When paused on the daily cap: ISO time the rolling 24h window frees up, so
  // the UI can show a specific local resume time. Null when not paused on it.
  daily_reset_at?: string | null;
}

export const pipeline = {
  start: (
    mission_id: string,
    count?: number,
    top_n?: number,
    top_contacts?: number,
    selected_functions?: string[],
    selected_seniority?: string[],
    selected_sectors?: string[]
  ) =>
    authedFetch<{ data: PipelineRunView; already_running?: boolean }>('/api/agents/pipeline', {
      mission_id,
      count,
      top_n,
      top_contacts,
      selected_functions,
      selected_seniority,
      selected_sectors,
    }),
  // The AI-proposed launch menus: people types (functions + seniority) and company sectors.
  contactTypes: (mission_id: string) =>
    authedFetch<{ data: { functions: ContactTypeOptionView[]; seniority: ContactTypeOptionView[]; sectors: ContactTypeOptionView[] } }>(
      `/api/agents/pipeline?contact_types=1&mission_id=${encodeURIComponent(mission_id)}`,
      null,
      'GET'
    ),
  status: (run_id: string) =>
    authedFetch<{ data: PipelineRunView }>(`/api/agents/pipeline?run_id=${encodeURIComponent(run_id)}`, null, 'GET'),
  latestForMission: (mission_id: string) =>
    authedFetch<{ data: PipelineRunView }>(
      `/api/agents/pipeline?mission_id=${encodeURIComponent(mission_id)}`,
      null,
      'GET'
    ),
  cancel: (run_id: string) =>
    authedFetch<{ ok: boolean }>('/api/agents/pipeline/cancel', { run_id }),
};

// Agent-run analytics. Server aggregates over the agent_runs telemetry; keys
// arrive snake-cased (authedFetch runs toFrontend on the payload). Data only
// spans the agent_runs TTL, so windows are capped at 30 days server-side.
export interface RunTypeStatView {
  agent_type: AgentType;
  runs: number;
  completed: number;
  failed: number;
  running: number;
  avg_ms: number;
  p95_ms: number;
  success_rate: number; // 0-1
}
export interface RunDayStatView {
  day: string; // UTC 'YYYY-MM-DD'
  runs: number;
  completed: number;
  failed: number;
}
export interface RunAnalyticsView {
  window_days: number;
  totals: {
    runs: number;
    completed: number;
    failed: number;
    running: number;
    success_rate: number; // 0-1
    avg_ms: number;
    p50_ms: number;
    p95_ms: number;
  };
  by_type: RunTypeStatView[];
  by_day: RunDayStatView[];
}

export const analytics = {
  runs: (days = 30) =>
    authedFetch<{ data: RunAnalyticsView }>(
      `/api/data/_analytics/agent-runs?days=${encodeURIComponent(days)}`,
      null,
      'GET'
    ),
};

// Billing / monetization. Note: authedFetch() snake-cases response keys, so the
// camelCase server payload arrives here as snake_case (values are untouched).
export interface BillingMe {
  plan: PlanId; // effective plan (free if canceled)
  purchased_plan: PlanId;
  plan_status: PlanStatus | null;
  plan_renews_at: string | null;
  has_billing_account: boolean;
  limits: {
    missions_per_month: number;
    agent_runs_per_day: number;
    agent_runs_per_minute: number;
  };
  usage: {
    missions_this_month: number;
    runs_today: number;
  };
}

export const billing = {
  me: () => authedFetch<BillingMe>('/api/billing/me', null, 'GET'),
  checkout: (plan: PlanId) => authedFetch<{ url: string }>('/api/billing/checkout', { plan }),
  portal: () => authedFetch<{ url: string }>('/api/billing/portal', {}),
};

export type { AgentRun };
