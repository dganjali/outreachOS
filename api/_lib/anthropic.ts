import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY() });
  return _client;
}

export const MODEL = () => env.ANTHROPIC_MODEL();

export const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305' as const,
  name: 'web_search' as const,
  max_uses: 5,
};

export interface JsonExtraction<T> {
  ok: boolean;
  data?: T;
  raw: string;
  citations: Array<{ url: string; title?: string }>;
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

export function extractJson<T>(message: Anthropic.Message): JsonExtraction<T> {
  const citations: Array<{ url: string; title?: string }> = [];
  let textOut = '';
  for (const block of message.content) {
    if (block.type === 'text') {
      textOut += block.text;
      const blockCites = (block as unknown as { citations?: Array<{ url?: string; title?: string }> }).citations;
      if (Array.isArray(blockCites)) {
        for (const c of blockCites) {
          if (c.url) citations.push({ url: c.url, title: c.title });
        }
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

function dedupeCitations(items: Array<{ url: string; title?: string }>) {
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string }> = [];
  for (const c of items) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}
