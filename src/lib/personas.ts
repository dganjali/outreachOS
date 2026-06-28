// Persona data helpers over the Supabase-shaped Mongo shim. A persona is a
// reusable voice = email style only (its StyleProfile + exemplars), selected or
// created at mission creation and refined in the ME → Voice tab. Campaign
// substance (offer/audience/proof) lives on the mission, not the voice.

import { supabase } from '../supabaseClient';
import type { MissionMode, Persona, ContextFact, StyleExemplar, StyleProfile } from '../types';

/** Mid-scale default: lean on the exemplar voice without copying its structure. */
export const DEFAULT_TEMPLATE_STRICTNESS = 50;

export function emptyStyleProfile(): StyleProfile {
  return { dimensions: {}, rules: [], banned_phrases: [], voice_summary: '', template_strictness: DEFAULT_TEMPLATE_STRICTNESS };
}

/**
 * Whether a voice has been calibrated - i.e. the user ran the "calibrate on a
 * real draft" step. Two signals, either of which means calibrated:
 *
 *  1. `onboarding_completed_at` is set. extract-style stamps this on the FIRST
 *     successful calibration (api/agents/extract-style.ts), so it's the reliable
 *     "they did the calibrate step" flag.
 *  2. `style_profile` has learned content (a voice_summary or any dimensions).
 *
 * We can't rely on (2) alone: extract-style is deliberately conservative and
 * often returns an empty delta from a single accepted draft, leaving the profile
 * blank even though calibration ran - which is why calibrated voices read
 * "uncalibrated". (1) closes that gap.
 */
export function isPersonaCalibrated(
  p: Pick<Persona, 'style_profile' | 'onboarding_completed_at'> | null | undefined
): boolean {
  if (!p) return false;
  if (p.onboarding_completed_at) return true;
  const sp = p.style_profile;
  if (!sp) return false;
  return Boolean(sp.voice_summary?.trim()) || Object.keys(sp.dimensions ?? {}).length > 0;
}

export async function listPersonas(userId: string): Promise<Persona[]> {
  const { data, error } = await supabase
    .from('personas')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return ((data as Persona[]) ?? []).filter((p) => !p.archived_at);
}

export async function createPersona(
  userId: string,
  input: { name: string; mode?: MissionMode | null }
): Promise<Persona> {
  const { data, error } = await supabase
    .from('personas')
    .insert({
      user_id: userId,
      name: input.name.trim() || 'Untitled persona',
      mode: input.mode ?? null,
      style_profile: emptyStyleProfile(),
      style_profile_version: 1,
      onboarding_completed_at: null,
      archived_at: null,
      excluded_fact_ids: [],
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'persona_create_failed');
  return data as Persona;
}

export async function getPersona(id: string): Promise<Persona | null> {
  const { data, error } = await supabase.from('personas').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return (data as Persona) ?? null;
}

export async function updatePersona(
  id: string,
  patch: Partial<{
    name: string;
    mode: MissionMode | null;
    style_profile: StyleProfile;
    style_profile_version: number;
    onboarding_completed_at: string | null;
    archived_at: string | null;
    excluded_fact_ids: string[];
  }>
): Promise<void> {
  const { error } = await supabase.from('personas').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Delete a voice. Soft-delete via `archived_at` so it disappears from the list
 * (listPersonas filters archived) while any missions that already reference it
 * keep working. Reversible by clearing `archived_at`.
 */
export async function deletePersona(id: string): Promise<void> {
  await updatePersona(id, { archived_at: new Date().toISOString() });
}

export interface PersonaBundle {
  persona: Persona;
  exemplars: StyleExemplar[];
}

/** Persona + its exemplars - a voice is style only, so no facts here. */
export async function getPersonaBundle(_userId: string, personaId: string): Promise<PersonaBundle | null> {
  const persona = await getPersona(personaId);
  if (!persona) return null;
  const exemplars = await listExemplars(personaId);
  return { persona, exemplars };
}

/**
 * Context facts available to a draft: the person-level memory bank always, plus
 * one mission's substance when `missionId` is given. Legacy persona-scoped facts
 * are ignored (the migration re-homes them to 'person').
 */
export async function listContextFacts(userId: string, missionId: string | null): Promise<ContextFact[]> {
  const { data, error } = await supabase.from('context_facts').select('*').eq('user_id', userId);
  if (error) throw new Error(error.message);
  const all = (data as ContextFact[]) ?? [];
  return all.filter(
    (f) => f.scope === 'person' || (missionId != null && f.scope === 'mission' && f.mission_id === missionId)
  );
}

export async function addContextFact(
  userId: string,
  input: { claim: string; type?: ContextFact['type']; scope?: 'person' | 'mission'; missionId?: string | null; provenance?: string }
): Promise<void> {
  const scope = input.scope ?? 'person';
  const { error } = await supabase.from('context_facts').insert({
    user_id: userId,
    scope,
    mission_id: scope === 'mission' ? input.missionId ?? null : null,
    persona_id: null,
    type: input.type ?? 'proof',
    claim: input.claim.trim(),
    date: null,
    evidence_url: null,
    provenance: input.provenance ?? 'answer',
    confidence: 0.7,
  });
  if (error) throw new Error(error.message);
}

export async function deleteContextFact(id: string): Promise<void> {
  const { error } = await supabase.from('context_facts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function listExemplars(personaId: string): Promise<StyleExemplar[]> {
  const { data, error } = await supabase.from('style_exemplars').select('*').eq('persona_id', personaId);
  if (error) throw new Error(error.message);
  return (data as StyleExemplar[]) ?? [];
}

export async function addExemplar(
  userId: string,
  personaId: string,
  input: { subject?: string | null; body: string; mode?: MissionMode | null }
): Promise<void> {
  const { error } = await supabase.from('style_exemplars').insert({
    user_id: userId,
    persona_id: personaId,
    subject: input.subject ?? null,
    body: input.body.trim(),
    mode: input.mode ?? null,
    source: 'user-provided',
    outcome: 'unknown',
  });
  if (error) throw new Error(error.message);
}

export async function deleteExemplar(id: string): Promise<void> {
  const { error } = await supabase.from('style_exemplars').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
