// API client for our /api/agents/* + /api/gmail/* endpoints.
// Updated to attach a Firebase ID token instead of a Supabase access token.

import { currentIdToken } from '../firebaseClient';
import type {
  Target,
  Contact,
  EvidencePack,
  EmailSequence,
  AgentRun,
  Integration,
  Profile,
  ReplyClassification,
  ParsedResumeFields,
} from '../types';
import type { PlanId, PlanStatus } from '../../shared/plans';

// Mongo stores docs in camelCase + `_id`; frontend types use snake_case + `id`.
// Convert response payloads in place so agent endpoints look identical to data
// queries that go through src/lib/db.ts.
function snakeKey(k: string): string {
  if (k === '_id' || k === 'id') return 'id';
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function toFrontend(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(toFrontend);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[snakeKey(k)] = toFrontend(val);
    }
    return out;
  }
  return v;
}

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
  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    const err = (payload as { error?: string; detail?: string; message?: string }) ?? {};
    throw new Error(err.detail || err.message || err.error || `HTTP ${res.status}`);
  }
  return toFrontend(payload) as T;
}

export const agents = {
  target: (mission_id: string, count?: number) =>
    authedFetch<{ run_id: string; targets: Target[]; source: 'apollo' | 'web_search' }>('/api/agents/target', {
      mission_id,
      count,
    }),
  contacts: (target_id: string) =>
    authedFetch<{ run_id: string; contacts: Contact[]; source: 'apollo' | 'web_search' }>(
      '/api/agents/contacts',
      { target_id }
    ),
  evidence: (target_id: string) =>
    authedFetch<{ run_id: string; evidence_pack: EvidencePack }>('/api/agents/evidence', {
      target_id,
    }),
  sequence: (contact_id: string) =>
    authedFetch<{ run_id: string; sequence: EmailSequence }>('/api/agents/sequence', {
      contact_id,
    }),
  reply: (reply_id: string) =>
    authedFetch<{ run_id: string; classification: { classification: ReplyClassification; urgency: string; key_points: string[]; suggested_response: { subject: string; body: string } | null; recommended_action: string } }>(
      '/api/agents/reply',
      { reply_id }
    ),
  enrichProfile: () =>
    authedFetch<{ run_id: string; profile: Profile; source: 'apollo' | 'web_search' }>(
      '/api/agents/enrich-profile',
      {}
    ),
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
  send: (sequence_id: string, touch_index: number, mode: 'draft' | 'send', to_override?: string) =>
    authedFetch<{
      sent_message_id: string;
      mode: 'draft' | 'send';
      gmail_message_id: string;
      gmail_thread_id: string;
      gmail_draft_id?: string;
    }>('/api/gmail/send', { sequence_id, touch_index, mode, to_override }),
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
  best_contact_id: string | null;
}

export interface PipelineRunView {
  id: string;
  mission_id: string;
  status: PipelineRunStatus;
  phase: 'targeting' | 'processing' | 'done';
  note: string | null;
  error: string | null;
  config: { target_count: number; top_n: number };
  cursor: { target_index: number; step: PipelineStep } | null;
  targets: PipelineTargetView[];
  started_at: string;
  completed_at: string | null;
}

export const pipeline = {
  start: (mission_id: string, count?: number, top_n?: number) =>
    authedFetch<{ data: PipelineRunView; already_running?: boolean }>('/api/agents/pipeline', {
      mission_id,
      count,
      top_n,
    }),
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
