// Autopilot steering - pure patch logic.
//
// Turns a SteerProposal (what the steer agent decided the user's instruction
// means) into a `missions` field update + a recipe-stage patch. Kept
// side-effect-free so it's unit testable and so the same merging runs on apply
// regardless of what the (client-sent) proposal claims.
//
// The agent does the interpretation; this module splits the proposal into the
// two stores it touches: the mission doc (goal/audience/geo/directive/fact-pins)
// and the mission recipe (every pipeline stage). Numeric clamping + list
// cleaning for the recipe live in recipe.ts (applyRecipePatch), so this module
// just forwards the recipe intent.

import type { RecipeStagesPatch } from './recipe';
import type { MissionDoc, SteerProposal } from '../../shared/schemas';

function camelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Deep-camelCase every object key. Backend counterpart to the frontend data
 * shim (src/lib/caseMap.ts), which snake_cases nested keys - so a snake_cased
 * payload (a stored proposal, or a recipe patch POSTed from the cockpit) comes
 * back as `target_description`/`contacts_per_company`. This restores the
 * camelCase the patch logic reads. Only KEYS are touched; string values (claims,
 * fact ids, change text) are not.
 */
export function deepCamelKeys(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(deepCamelKeys);
  if (raw && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(raw as Record<string, unknown>)) out[camelKey(k)] = deepCamelKeys(val);
    return out;
  }
  return raw;
}

export function normalizeProposal(raw: unknown): SteerProposal {
  return (deepCamelKeys(raw ?? {}) as SteerProposal) ?? ({ changes: [] } as SteerProposal);
}

export interface SteerUpdates {
  missionUpdate: Partial<MissionDoc>;
  recipePatch: RecipeStagesPatch;
}

/**
 * Split a steering proposal into a mission field update + a recipe-stage patch.
 * `mission` is the current mission doc (needed to append to the standing
 * directive and to merge fact pins); `validFactIds`, when given, restricts which
 * ids may be pinned (server passes the user's own fact ids so a tampered proposal
 * can't pin a stranger's fact). The recipe patch is forwarded raw - recipe.ts
 * clamps + cleans it on apply.
 */
export function buildSteerUpdates(
  mission: Pick<MissionDoc, 'draftDirective' | 'emphasizedFactIds'>,
  proposal: SteerProposal,
  opts: { validFactIds?: Set<string> } = {}
): SteerUpdates {
  const missionUpdate: Partial<MissionDoc> = {};

  const m = proposal.mission;
  if (m) {
    if (typeof m.goal === 'string' && m.goal.trim()) missionUpdate.goal = m.goal.trim();
    if (typeof m.targetDescription === 'string' && m.targetDescription.trim()) {
      missionUpdate.targetDescription = m.targetDescription.trim();
    }
    if (m.geo !== undefined) missionUpdate.geo = m.geo?.trim() || null;

    // Directive: an explicit value replaces; an append tacks a line onto the
    // existing one. Replace wins if (oddly) both are present.
    if (typeof m.draftDirective === 'string') {
      missionUpdate.draftDirective = m.draftDirective.trim() || null;
    } else if (typeof m.draftDirectiveAppend === 'string' && m.draftDirectiveAppend.trim()) {
      const existing = (mission.draftDirective ?? '').trim();
      const line = m.draftDirectiveAppend.trim();
      missionUpdate.draftDirective = existing ? `${existing}\n${line}` : line;
    }

    if (m.clearIcp) {
      // Force the next sourcing cycle to regenerate targeting from the new brief.
      missionUpdate.contactIcp = null;
      missionUpdate.sectorSuggestions = null;
    }
  }

  // Recipe patch: forward the proposal's stage intent as-is. applyRecipePatch
  // merges it onto the current recipe and clamps every value.
  const recipePatch: RecipeStagesPatch = (proposal.recipe ?? {}) as RecipeStagesPatch;

  // Fact pins: merge add/remove into the current set, dropping any unowned id.
  const hasFactChange = (proposal.emphasizeFactIds?.length ?? 0) > 0 || (proposal.deemphasizeFactIds?.length ?? 0) > 0;
  if (hasFactChange) {
    const set = new Set(mission.emphasizedFactIds ?? []);
    for (const id of proposal.emphasizeFactIds ?? []) {
      if (!opts.validFactIds || opts.validFactIds.has(id)) set.add(id);
    }
    for (const id of proposal.deemphasizeFactIds ?? []) set.delete(id);
    missionUpdate.emphasizedFactIds = [...set];
  }

  return { missionUpdate, recipePatch };
}

/** True when a proposal would change nothing (e.g. a pure clarification). */
export function isEmptyUpdate(u: { missionUpdate: Partial<MissionDoc>; recipePatch: RecipeStagesPatch }): boolean {
  if (Object.keys(u.missionUpdate).length > 0) return false;
  const p = u.recipePatch;
  return (
    p.automationEnabled === undefined &&
    !hasKeys(p.sourcing) &&
    !hasKeys(p.verification) &&
    !hasKeys(p.research) &&
    !hasKeys(p.personSourcing) &&
    !hasKeys(p.sequencing) &&
    !hasKeys(p.send)
  );
}

function hasKeys(o: object | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}
