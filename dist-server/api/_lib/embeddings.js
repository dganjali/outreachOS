// Voyage AI embeddings — used to populate the `embedding` field on
// evidence_packs, email_sequences, and profile_assets chunks so that Atlas
// Vector Search can do semantic retrieval.
import { env } from './env';
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
export const EMBED_MODEL = 'voyage-3';
export const EMBED_DIM = 1024;
export async function embed(texts, inputType = 'document') {
    if (texts.length === 0)
        return [];
    const r = await fetch(VOYAGE_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.VOYAGE_API_KEY()}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            input: texts,
            model: EMBED_MODEL,
            input_type: inputType,
        }),
    });
    if (!r.ok)
        throw new Error(`voyage_embed_failed: ${await r.text()}`);
    const j = (await r.json());
    return j.data.map((d) => d.embedding);
}
export async function embedOne(text, inputType = 'document') {
    const [v] = await embed([text], inputType);
    return v;
}
