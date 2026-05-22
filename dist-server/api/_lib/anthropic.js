import Anthropic from '@anthropic-ai/sdk';
import { env } from './env';
let _client = null;
export function anthropic() {
    if (_client)
        return _client;
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY() });
    return _client;
}
export const MODEL = () => env.ANTHROPIC_MODEL();
export const WEB_SEARCH_TOOL = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 10,
};
export async function createMessageWithRetry(params) {
    const delays = [1000, 3000];
    let lastErr;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            return await anthropic().messages.create(params);
        }
        catch (err) {
            lastErr = err;
            const status = err?.status;
            const retryable = status === 529 || (typeof status === 'number' && status >= 500 && status < 600);
            if (!retryable || attempt === delays.length)
                throw err;
            await new Promise((r) => setTimeout(r, delays[attempt]));
        }
    }
    throw lastErr;
}
function tryParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) {
            try {
                return JSON.parse(fence[1]);
            }
            catch {
                return null;
            }
        }
        const first = text.indexOf('{');
        const last = text.lastIndexOf('}');
        if (first !== -1 && last > first) {
            try {
                return JSON.parse(text.slice(first, last + 1));
            }
            catch {
                return null;
            }
        }
        return null;
    }
}
export function extractJson(message) {
    const citations = [];
    let textOut = '';
    for (const block of message.content) {
        if (block.type === 'text') {
            textOut += block.text;
            const blockCites = block.citations;
            if (Array.isArray(blockCites)) {
                for (const c of blockCites) {
                    if (c.url)
                        citations.push({ url: c.url, title: c.title });
                }
            }
        }
    }
    const parsed = tryParse(textOut);
    return {
        ok: parsed !== null,
        data: parsed ?? undefined,
        raw: textOut,
        citations: dedupeCitations(citations),
    };
}
function dedupeCitations(items) {
    const seen = new Set();
    const out = [];
    for (const c of items) {
        if (seen.has(c.url))
            continue;
        seen.add(c.url);
        out.push(c);
    }
    return out;
}
