// Recipient verification - the gate that keeps cold emails off the WRONG person.
//
// Contact discovery (api/agents/contacts.ts) and people discovery
// (api/agents/people.ts) find candidates by function keyword + seniority. That
// surfaces people who SHARE a job function but don't actually own the ask, and -
// in people mode - people who no longer hold the affiliation the mission needs
// (graduated, left the company). This module researches ONE specific person and
// decides whether they genuinely fit the mission's hard requirement before we
// draft, so a 'mismatch' can be dropped (the contacts walk treats a mismatch
// exactly like an unreachable email: skip and try the next candidate).

import { MODEL, WEB_SEARCH_TOOL, generateJsonWithSearch } from './llm';
import { VERIFY_CONTACT_SYSTEM } from './prompts';
import { MODE_LABEL, type MissionMode } from './prompts';
import type { ContactIcp } from '../../shared/types';

export type Verdict = 'match' | 'weak' | 'mismatch';

export interface PersonResearchFact {
  fact: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
}

export interface ContactVerification {
  verdict: Verdict;
  confidence: number; // 0..1
  reason: string;
  research: PersonResearchFact[];
}

export interface VerifyContactArgs {
  person: {
    name: string;
    role: string | null;
    headline: string | null;
    linkedinUrl: string | null;
    location: string | null;
  };
  company: string;
  domain: string | null;
  mission: {
    mode: MissionMode;
    goal: string;
    offerDetails: string | null;
    targetDescription: string;
  };
  icp: ContactIcp;
}

interface RawVerification {
  verdict?: string;
  confidence?: number;
  reason?: string;
  research?: Array<{ fact?: string; source_url?: string | null; source_title?: string | null }>;
}

/** When verification can't run (LLM/search error or unparseable output) we must
 *  not silently drop a good person nor silently bless a bad one. Fail OPEN as
 *  'weak' with low confidence and a clear reason: the contact is kept (so a flaky
 *  search doesn't crater the pipeline into endless replacement) but is never
 *  labelled a confirmed match. Downstream gates can treat 'weak' cautiously. */
function unverifiable(reason: string): ContactVerification {
  return { verdict: 'weak', confidence: 0.25, reason, research: [] };
}

/** Research one person and judge whether they fit the mission's hard
 *  requirement. Never throws - returns an 'unverifiable' weak verdict on any
 *  failure so the caller's keep/drop logic stays simple. */
export async function verifyContactFit(args: VerifyContactArgs): Promise<ContactVerification> {
  const { person, company, domain, mission, icp } = args;
  const userPrompt = [
    'PERSON TO VERIFY:',
    `- name: ${person.name}`,
    `- title (as discovered, verify it): ${person.role ?? 'unknown'}`,
    person.headline ? `- headline: ${person.headline}` : '',
    `- current company/organization: ${company}${domain ? ` (${domain})` : ''}`,
    person.location ? `- location: ${person.location}` : '',
    person.linkedinUrl ? `- linkedin: ${person.linkedinUrl}` : '',
    '',
    'MISSION THEY WOULD BE EMAILED ABOUT:',
    `- type: ${MODE_LABEL[mission.mode]}`,
    `- what's being offered: ${mission.goal}`,
    mission.offerDetails ? `- offer details: ${mission.offerDetails}` : '',
    `- who the mission must reach (the audience): ${mission.targetDescription}`,
    icp.functions.length ? `- target functions: ${icp.functions.join(', ')}` : '',
    icp.geo.preferred ? `- location focus: ${icp.geo.preferred}` : '',
    '',
    'Derive the hard requirements from the audience + offer, verify this person against them with web_search, and return the verdict JSON.',
  ]
    .filter(Boolean)
    .join('\n');

  let parsed;
  try {
    parsed = await generateJsonWithSearch<RawVerification>({
      model: MODEL(),
      max_tokens: 1536,
      system: VERIFY_CONTACT_SYSTEM,
      tools: [WEB_SEARCH_TOOL],
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.warn('verify_contact_failed', person.name, err);
    return unverifiable('verification could not run (research unavailable)');
  }
  if (!parsed.ok || !parsed.data) return unverifiable('verification returned no usable result');
  return normalizeVerification(parsed.data);
}

/** Map the raw model output onto a safe, typed verification. An unrecognized
 *  verdict is treated as 'weak' (not a free pass to 'match', not a hard drop). */
export function normalizeVerification(raw: RawVerification): ContactVerification {
  const verdict = coerceVerdict(raw.verdict);
  const research = Array.isArray(raw.research)
    ? raw.research
        .map((r) => ({
          fact: typeof r?.fact === 'string' ? r.fact.trim() : '',
          sourceUrl: typeof r?.source_url === 'string' && r.source_url.trim() ? r.source_url.trim() : null,
          sourceTitle: typeof r?.source_title === 'string' && r.source_title.trim() ? r.source_title.trim() : null,
        }))
        .filter((r) => r.fact.length > 0)
        .slice(0, 4)
    : [];
  return {
    verdict,
    confidence: clamp01(raw.confidence),
    reason: typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : 'no reason given',
    research,
  };
}

function coerceVerdict(v: unknown): Verdict {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'match' || s === 'mismatch') return s;
  return 'weak';
}

/** A verified contact is kept unless it is a clear 'mismatch'. 'weak' (plausible
 *  but unconfirmed, or unverifiable) is kept - we drop only what evidence
 *  actively contradicts, so a thin public footprint never silently nukes a real
 *  prospect. */
export function verdictAccepted(v: ContactVerification): boolean {
  return v.verdict !== 'mismatch';
}

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
