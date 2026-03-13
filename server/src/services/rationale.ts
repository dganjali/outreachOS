import { generateText } from './llm/gemini.js';

export async function generateRationale(
  companies: string[],
  criteria: string,
  ask: string,
  contactsPerCompany: number
): Promise<string> {
  const system = 'You are helping plan a cold outreach campaign. Be concise and specific.';

  const user = [
    `We are reaching out to these companies: ${companies.join(', ')}.`,
    `We want to reach: ${criteria} (${contactsPerCompany} contact(s) per company).`,
    `Our ask: ${ask}.`,
    'Write 3-4 sentences explaining who we will target at each company, why they are the right person for this ask, and what signal we use to find them.',
    'Be specific and direct. No filler phrases.'
  ].join(' ');

  try {
    return await generateText({ system, prompt: user });
  } catch (err) {
    const fallback = [
      'This mission targets senior decision-makers at the listed companies who are closest to your ask.',
      `Focus on roles that match: ${criteria}.`,
      'Prioritize people whose public profiles mention budget ownership, partnerships, or content/podcast responsibilities.'
    ].join(' ');

    if (err instanceof Error) {
      return `${fallback} (LLM rationale unavailable: ${err.message})`;
    }

    return `${fallback} (LLM rationale unavailable.)`;
  }
}

