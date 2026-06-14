// Text embeddings - Gemini on Vertex AI (gemini-embedding-001).
//
// Populates the `embedding` field on evidence_packs, email_sequences, and
// profile_assets chunks so Atlas Vector Search can do semantic retrieval.
//
// Output is pinned to 1024 dims to match the existing Atlas vector indexes
// (shared/schemas.ts, numDimensions: 1024). Auth is via ADC (the Cloud Run
// runtime service account) - same as the Gemini chat adapter, no API key.

import { GoogleGenAI } from '@google/genai';
import { env } from './env';

export const EMBED_MODEL = () => env.GEMINI_EMBED_MODEL();
export const EMBED_DIM = 1024;

export type EmbedInputType = 'document' | 'query';

// Voyage 'document' | 'query'  ->  Vertex task types.
const TASK_TYPE: Record<EmbedInputType, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
};

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

export async function embed(
  texts: string[],
  inputType: EmbedInputType = 'document'
): Promise<number[][]> {
  if (texts.length === 0) return [];
  // gemini-embedding-001 on Vertex takes one instance per request; embed
  // sequentially. All current call sites use embedOne (single text) anyway.
  const out: number[][] = [];
  for (const text of texts) {
    out.push(await embedSingle(text, inputType));
  }
  return out;
}

async function embedSingle(text: string, inputType: EmbedInputType): Promise<number[]> {
  const resp = await client().models.embedContent({
    model: EMBED_MODEL(),
    contents: [{ parts: [{ text }] }],
    config: {
      taskType: TASK_TYPE[inputType],
      outputDimensionality: EMBED_DIM,
    },
  });
  const values = resp.embeddings?.[0]?.values;
  if (!values || values.length === 0) throw new Error('vertex_embed_empty');
  return values;
}

export async function embedOne(text: string, inputType: EmbedInputType = 'document'): Promise<number[]> {
  return embedSingle(text, inputType);
}
