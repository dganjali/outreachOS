// LLM adapter — Gemini on Vertex AI.
//
// (Formerly api/_lib/anthropic.ts — the name was historical and misleading; the
// app runs Gemini, not Anthropic. Renamed to api/_lib/llm.ts.)
//
// Auth: Application Default Credentials. On Cloud Run this is the runtime
// service account (needs roles/aiplatform.user). Locally, `gcloud auth
// application-default login` or GOOGLE_APPLICATION_CREDENTIALS.
//
// Two model tiers (env.ts): MODEL() = gemini-2.5-flash (cheap — research,
// judging, extraction); MODEL_PRO() = gemini-2.5-pro (quality-critical draft
// generation). Structured output is opt-in via `responseJsonSchema` — when set,
// Gemini is constrained to emit JSON matching the schema (no fences, no prose),
// so extractJson parses cleanly and the parse_failed path disappears.

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

// Cheap default tier (flash) and quality tier (pro). Callers choose per-call:
// the draft generator uses MODEL_PRO(); judges/extractors/research use MODEL().
export const MODEL = () => env.GEMINI_MODEL();
export const MODEL_PRO = () => env.GEMINI_PRO_MODEL();

// Google Search grounding — Gemini's equivalent of Anthropic's web_search tool.
// Agents spread this straight into `tools: [WEB_SEARCH_TOOL]`. Mutually
// exclusive with responseJsonSchema (structured output can't run search).
export const WEB_SEARCH_TOOL = { googleSearch: {} } as const;

// ---- Param + result shapes ----

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  // When set, Gemini is constrained to emit JSON matching this (flat) JSON
  // Schema. Do NOT combine with `tools` (web search). Recursive schemas are not
  // supported — keep them flat.
  responseJsonSchema?: unknown;
  // Override the default sampling temperature (0.4). Generation wants more
  // variance (~0.7); judges/extractors want determinism (~0.2).
  temperature?: number;
  // Vertex CachedContent resource name. When set, the cached prefix (static
  // system prompt + exemplars) is reused instead of re-sent. Created via a
  // helper wired in Phase 3; this passthrough lets callers opt in early.
  cachedContent?: string;
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
    temperature: params.temperature ?? 0.4,
  };
  if (params.system) config.systemInstruction = params.system;
  // Structured output and web search are mutually exclusive; prefer structure.
  if (params.responseJsonSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = params.responseJsonSchema;
  } else if (params.tools && params.tools.length) {
    config.tools = params.tools;
  }
  if (params.cachedContent) config.cachedContent = params.cachedContent;
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

// ---- JSON extraction ----

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

/**
 * Structured-output convenience: run a call with a JSON Schema constraint and
 * return the parsed, typed result. Preferred over raw createMessageWithRetry +
 * extractJson for all new agents (draft, critique, extract-style, etc.) — the
 * schema both shapes the output and removes the brittle prose-scraping path.
 */
export async function generateJson<T>(
  params: Omit<CreateMessageParams, 'responseJsonSchema'> & { responseJsonSchema: unknown }
): Promise<JsonExtraction<T>> {
  const message = await createMessageWithRetry(params);
  return extractJson<T>(message);
}

// ---- OCR via Gemini multimodal ----
// Inline data is sent base64; Vertex caps a request at ~20MB total, so base64
// inflation (~33%) means the raw file must stay well under that.
const OCR_MAX_BYTES = 14 * 1024 * 1024;
const OCR_PROMPT =
  'You are an OCR engine. Transcribe ALL readable text from this document verbatim, ' +
  'preserving reading order and line breaks. Output only the transcribed text — no ' +
  'commentary, no markdown fences, no explanations. If the document has no readable ' +
  'text at all, output nothing.';

/**
 * OCR a PDF or image by handing the raw bytes to Gemini (which reads them
 * natively). Used as a fallback when deterministic text extraction finds no
 * embedded text layer (scanned/image-only files). Returns the transcribed text
 * (possibly empty if the file genuinely has no readable text).
 */
export async function ocrTranscribe(buf: Buffer, mimeType: string): Promise<string> {
  if (buf.length > OCR_MAX_BYTES) {
    throw Object.assign(new Error('File too large to OCR — please upload a file under 14MB.'), {
      code: 'ocr_too_large',
    });
  }
  const model = MODEL(); // flash 2.5 — cheap, strong multimodal OCR
  const config: Record<string, unknown> = {
    temperature: 0,
    // Generous budget so multi-page scanned documents aren't silently
    // truncated mid-transcription (8k tokens ≈ 6k words ran out on long PDFs).
    maxOutputTokens: 32768,
  };
  if (isThinkingModel(model)) config.thinkingConfig = { thinkingBudget: 0 };

  const resp = await client().models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType, data: buf.toString('base64') } }, { text: OCR_PROMPT }],
      },
    ],
    config,
  });

  let text = '';
  for (const part of resp.candidates?.[0]?.content?.parts ?? []) {
    if (typeof (part as { text?: string }).text === 'string') text += (part as { text: string }).text;
  }
  return text.trim();
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
