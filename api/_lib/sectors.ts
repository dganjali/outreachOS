// AI-suggested company sectors for a mission's targeting. Mirrors the contact-ICP
// flow (api/_lib/icp.ts) but for WHICH companies rather than WHO inside them: the
// AI proposes the sectors most worth going after for this offer/audience, the
// human narrows them, and the selection biases the targeting agent's search.

import { generateJson, MODEL } from './llm';
import type { UserScope } from './db';
import type { MissionDoc } from '../../shared/schemas';
import type { ContactTypeOption, SectorSuggestion } from '../../shared/types';

const MAX_SECTORS = 10;

const SECTORS_SYSTEM = [
  'You suggest the company sectors / industries most worth targeting for a cold-outreach mission.',
  'Given the offer and the audience, propose 6-10 concrete, recognizable sectors',
  '(e.g. "developer tools", "fintech", "e-commerce platforms", "healthcare SaaS").',
  'Each sector is a short noun phrase a person would recognize - never a full sentence.',
  'Mark the 3-5 strongest fits as recommended:true. Output JSON only.',
].join(' ');

const SECTORS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sectors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          recommended: { type: 'boolean' },
        },
        required: ['name', 'recommended'],
      },
    },
  },
  required: ['sectors'],
} as const;

function normalizeSectors(raw: unknown): SectorSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: SectorSuggestion[] = [];
  for (const s of raw) {
    const name = typeof (s as SectorSuggestion)?.name === 'string' ? (s as SectorSuggestion).name.trim() : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, recommended: Boolean((s as SectorSuggestion)?.recommended) });
    if (out.length >= MAX_SECTORS) break;
  }
  return out;
}

/** Ask the model for the sectors worth targeting for this mission. Best-effort:
 *  any failure yields an empty list and the launch screen just omits the section. */
export async function synthesizeSectors(mission: MissionDoc): Promise<SectorSuggestion[]> {
  const userPrompt = [
    `Mission: ${mission.name}`,
    `Mode: ${mission.mode}`,
    `Offer / what's being sent: ${mission.goal}`,
    mission.offerDetails ? `Offer details: ${mission.offerDetails}` : '',
    `Audience / who to reach: ${mission.targetDescription}`,
    mission.geo ? `Location focus: ${mission.geo}` : '',
    '',
    'Suggest the company sectors most worth targeting. Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const { ok, data } = await generateJson<{ sectors?: SectorSuggestion[] }>({
      model: MODEL(),
      max_tokens: 512,
      temperature: 0.3,
      system: SECTORS_SYSTEM,
      responseJsonSchema: SECTORS_SCHEMA,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return normalizeSectors(ok ? data?.sectors : null);
  } catch (err) {
    console.warn('synthesize_sectors_failed', mission._id, err);
    return [];
  }
}

/** Lazily synthesize + cache the mission's sector suggestions. */
export async function getOrCreateSectors(scope: UserScope, mission: MissionDoc): Promise<SectorSuggestion[]> {
  if (mission.sectorSuggestions && mission.sectorSuggestions.length > 0) return mission.sectorSuggestions;
  const sectors = await synthesizeSectors(mission);
  if (sectors.length > 0) {
    try {
      await scope
        .collection<MissionDoc>('missions')
        .updateById(mission._id, { sectorSuggestions: sectors } as Partial<MissionDoc>);
    } catch (err) {
      console.warn('persist_sectors_failed', mission._id, err);
    }
  }
  return sectors;
}

/** Turn cached suggestions into the checkbox menu the launch screen renders. */
export function buildSectorOptions(suggestions: SectorSuggestion[]): ContactTypeOption[] {
  return suggestions.map((s) => ({
    id: `sector:${s.name.toLowerCase()}`,
    kind: 'sector',
    label: s.name,
    value: s.name,
    recommended: s.recommended,
  }));
}
