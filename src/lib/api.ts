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
  return payload as T;
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
};

export type { AgentRun };
