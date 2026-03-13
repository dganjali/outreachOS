import { prisma } from '../db/client.js';
import { generateText } from './llm/gemini.js';

export interface HunterContact {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  confidence: number;
}

// Search all contacts at a domain
export async function searchDomain(
  domain: string,
  apiKey: string
): Promise<HunterContact[]> {
  const url = new URL('https://api.hunter.io/v2/domain-search');
  url.searchParams.set('domain', domain);
  url.searchParams.set('limit', '10');
  url.searchParams.set('api_key', apiKey);

  const res = await fetch(url.toString());

  if (!res.ok) {
    let message = `Hunter domain-search failed with status ${res.status}`;
    try {
      const errorBody = (await res.json()) as { errors?: { details?: string }[] };
      if (errorBody.errors?.[0]?.details) {
        message += `: ${errorBody.errors[0].details}`;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const data = (await res.json()) as {
    data?: { emails?: { value: string; first_name: string; last_name: string; position: string; confidence: number }[] };
  };

  const emails = data.data?.emails ?? [];

  return emails.map((e) => ({
    email: e.value,
    firstName: e.first_name,
    lastName: e.last_name,
    role: e.position,
    confidence: e.confidence
  }));
}

// Verify a single email address
export async function verifyEmail(
  email: string,
  apiKey: string
): Promise<'deliverable' | 'risky' | 'undeliverable'> {
  const url = new URL('https://api.hunter.io/v2/email-verifier');
  url.searchParams.set('email', email);
  url.searchParams.set('api_key', apiKey);

  const res = await fetch(url.toString());

  if (!res.ok) {
    let message = `Hunter email-verifier failed with status ${res.status}`;
    try {
      const errorBody = (await res.json()) as { errors?: { details?: string }[] };
      if (errorBody.errors?.[0]?.details) {
        message += `: ${errorBody.errors[0].details}`;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  const data = (await res.json()) as { data?: { result?: 'deliverable' | 'risky' | 'undeliverable' } };
  const result = data.data?.result;

  if (result === 'deliverable' || result === 'risky' || result === 'undeliverable') {
    return result;
  }

  throw new Error('Hunter email-verifier returned an unknown result');
}

// Filter and rank contacts by plain-text role criteria using Gemini
export async function filterByRole(
  contacts: HunterContact[],
  criteria: string,
  count: number
): Promise<HunterContact[]> {
  if (!contacts.length || count <= 0) return [];

  try {
    const minimalContacts = contacts.map((c) => ({
      email: c.email,
      role: c.role
    }));

    const prompt = [
      `Given these contacts: ${JSON.stringify(minimalContacts)}.`,
      `Targeting criteria: ${criteria}.`,
      `Return ONLY a JSON array of the top ${count} email addresses that best match, ordered by relevance.`,
      'No other text, no explanations.'
    ].join(' ');

    const raw = await generateText({
      system: 'You are helping select the best contacts for a B2B outreach campaign.',
      prompt
    });

    const cleaned = raw
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    const emails = JSON.parse(cleaned) as string[];
    const emailSet = new Set(emails);

    const ranked = contacts.filter((c) => emailSet.has(c.email));

    // Preserve original order for any extras to fill up to count.
    if (ranked.length < count) {
      for (const c of contacts) {
        if (!emailSet.has(c.email)) {
          ranked.push(c);
        }
        if (ranked.length >= count) break;
      }
    }

    return ranked.slice(0, count);
  } catch {
    // Fallback: return first N contacts unfiltered.
    return contacts.slice(0, count);
  }
}

