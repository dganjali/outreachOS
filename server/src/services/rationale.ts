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

  const text = await generateText({ system, prompt: user });

  return text;
}

