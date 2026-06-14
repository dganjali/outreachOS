// Persona data helpers over the Supabase-shaped Mongo shim. A persona is a
// reusable, use-case-scoped voice (its StyleProfile + offer/audience) selected
// or created at mission creation and refined in the ME → Voice tab.

import { supabase } from '../supabaseClient';
import type { MissionMode, Persona, ContextFact, StyleExemplar, StyleProfile } from '../types';

export function emptyStyleProfile(): StyleProfile {
  return { dimensions: {}, rules: [], banned_phrases: [], voice_summary: '' };
}

/**
 * Whether a voice has actually learned a style — i.e. the user ran the
 * "calibrate on a real draft" step and extract-style populated the profile.
 *
 * This is the real signal for the "Calibrated" badge. `onboarding_completed_at`
 * only flips when the user clicks Done on the wizard overview, so a fully
 * calibrated voice would otherwise read "uncalibrated" until that final tap.
 */
export function isPersonaCalibrated(p: Pick<Persona, 'style_profile'> | null | undefined): boolean {
  const sp = p?.style_profile;
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
  input: { name: string; mode?: MissionMode | null; offer?: string | null; audience?: string | null }
): Promise<Persona> {
  const { data, error } = await supabase
    .from('personas')
    .insert({
      user_id: userId,
      name: input.name.trim() || 'Untitled persona',
      mode: input.mode ?? null,
      offer: input.offer ?? null,
      audience: input.audience ?? null,
      style_profile: emptyStyleProfile(),
      style_profile_version: 1,
      onboarding_completed_at: null,
      archived_at: null,
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
    offer: string | null;
    audience: string | null;
    style_profile: StyleProfile;
    style_profile_version: number;
    onboarding_completed_at: string | null;
    archived_at: string | null;
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
  facts: ContextFact[];
  exemplars: StyleExemplar[];
}

/** Persona + its persona-scoped facts + exemplars — everything the wizard edits. */
export async function getPersonaBundle(userId: string, personaId: string): Promise<PersonaBundle | null> {
  const persona = await getPersona(personaId);
  if (!persona) return null;
  const [facts, exemplars] = await Promise.all([
    listContextFacts(userId, personaId),
    listExemplars(personaId),
  ]);
  // Edit only the facts that belong to this persona; person-level facts are owned
  // by the Context tab, not the per-voice wizard.
  return { persona, facts: facts.filter((f) => f.scope === 'persona'), exemplars };
}

export async function listContextFacts(userId: string, personaId: string | null): Promise<ContextFact[]> {
  const { data, error } = await supabase.from('context_facts').select('*').eq('user_id', userId);
  if (error) throw new Error(error.message);
  const all = (data as ContextFact[]) ?? [];
  // person-level facts apply to every persona; persona-level only to this one.
  return all.filter((f) => f.scope === 'person' || (personaId && f.persona_id === personaId));
}

export async function addContextFact(
  userId: string,
  input: { claim: string; type?: ContextFact['type']; scope?: 'person' | 'persona'; personaId?: string | null; provenance?: string }
): Promise<void> {
  const { error } = await supabase.from('context_facts').insert({
    user_id: userId,
    scope: input.scope ?? 'person',
    persona_id: input.scope === 'persona' ? input.personaId ?? null : null,
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
