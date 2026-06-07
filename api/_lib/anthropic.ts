// LLM adapter — Gemini on Vertex AI.
//
// NOTE: file name is historical. It used to wrap the Anthropic SDK; it now
// wraps Google Gemini via Vertex AI. The public surface is intentionally
// UNCHANGED (createMessageWithRetry / extractJson / WEB_SEARCH_TOOL / MODEL)
// so the 8 agent handlers and the pipeline orchestrator did not have to change.
//
// Auth: Application Default Credentials. On Cloud Run this is the runtime
// service account (needs roles/aiplatform.user). Locally, `gcloud auth
// application-default login` or GOOGLE_APPLICATION_CREDENTIALS.

import { GoogleGenAI } from '@google/genai';
import { env } from './env';

let _client: GoogleGenAI | null = null;

function client(): GoogleGenAI {
  if (_client) return _client;
  _client = new GoogleGenAI({
    vertexai: true,
    project: env.GCP_PROJECT_ID(),
    location: env.VERTEX_LOCATION(),
  });
  return _client;
}

export const MODEL = () => env.GEMINI_MODEL();

// Google Search grounding — Gemini's equivalent of Anthropic's web_search tool.
// Agents spread this straight into `tools: [WEB_SEARCH_TOOL]`.
export const WEB_SEARCH_TOOL = { googleSearch: {} } as const;

// ---- Param + result shapes (mirror the old Anthropic call sites) ----

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface Citation {
  url: string;
  title?: string;
}

// A normalized "message" with the one field extractJson reads: content blocks.
export interface LlmMessage {
  content: Array<{ type: 'text'; text: string; citations: Citation[] }>;
}

function isThinkingModel(model: string): boolean {
  return /2\.5/.test(model);
}

export async function createMessageWithRetry(params: CreateMessageParams): Promise<LlmMessage> {
  const delays = [1000, 3000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await createMessage(params);
    } catch (err) {
      lastErr = err;
      const status = errStatus(err);
      const retryable = status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
      if (!retryable || attempt === delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

async function createMessage(params: CreateMessageParams): Promise<LlmMessage> {
  const model = params.model || MODEL();

  const contents = params.messages.map((m) => ({
    // Gemini roles are 'user' | 'model'. Our agents only ever send 'user'.
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // Flash 2.5 lets us turn thinking off so the whole output budget goes to the
  // answer (and small max_tokens calls don't get starved). Pro keeps a minimum
  // thinking budget, so we just give it generous headroom.
  const isFlash = /flash/i.test(model);
  const config: Record<string, unknown> = {
    maxOutputTokens: Math.max(params.max_tokens ?? 2048, 1024),
    temperature: 0.4,
  };
  if (params.system) config.systemInstruction = params.system;
  if (params.tools && params.tools.length) config.tools = params.tools;
  if (isThinkingModel(model)) {
    config.thinkingConfig = { thinkingBudget: isFlash ? 0 : 1024 };
    if (!isFlash) config.maxOutputTokens = Math.max(params.max_tokens ?? 2048, 4096) + 1024;
  }

  const resp = await client().models.generateContent({ model, contents, config });

  let text = '';
  const citations: Citation[] = [];
  const candidate = resp.candidates?.[0];
  for (const part of candidate?.content?.parts ?? []) {
    if (typeof (part as { text?: string }).text === 'string') text += (part as { text: string }).text;
  }
  // Fallback to the SDK's convenience accumulator if parts were empty.
  if (!text && typeof (resp as { text?: string }).text === 'string') text = (resp as { text: string }).text;

  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const web = (chunk as { web?: { uri?: string; title?: string } }).web;
    if (web?.uri) citations.push({ url: web.uri, title: web.title });
  }

  return { content: [{ type: 'text', text, citations: dedupeCitations(citations) }] };
}

function errStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number; response?: { status?: number } };
  if (typeof e?.status === 'number') return e.status;
  if (typeof e?.code === 'number') return e.code;
  if (typeof e?.response?.status === 'number') return e.response.status;
  // Gemini ApiError messages sometimes embed the code: "got status: 503 ..."
  const m = String((err as { message?: string })?.message ?? '').match(/\b(429|5\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}

// ---- JSON extraction (unchanged public behavior) ----

export interface JsonExtraction<T> {
  ok: boolean;
  data?: T;
  raw: string;
  citations: Citation[];
}

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        return null;
      }
    }
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function extractJson<T>(message: LlmMessage): JsonExtraction<T> {
  const citations: Citation[] = [];
  let textOut = '';
  for (const block of message.content) {
    if (block.type === 'text') {
      textOut += block.text;
      for (const c of block.citations ?? []) {
        if (c.url) citations.push({ url: c.url, title: c.title });
      }
    }
  }
  const parsed = tryParse(textOut) as T | null;
  return {
    ok: parsed !== null,
    data: parsed ?? undefined,
    raw: textOut,
    citations: dedupeCitations(citations),
  };
}

function dedupeCitations(items: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of items) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}
