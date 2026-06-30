// Autopilot steering - pure patch logic.
//
// Turns a SteerProposal (what the steer agent decided the user's instruction
// means) into concrete `missions` + `campaign_policies` field updates. Kept
// side-effect-free so it's unit testable and so the same clamping/merging runs
// on apply regardless of what the (client-sent) proposal claims.
//
// The agent does the interpretation; this module is the safety layer: clamp
// every numeric to sane bounds, normalize sectors, and merge fact pins.

import { MAX_DAILY_SEND_CAP, MAX_TARGETS_PER_CYCLE } from './autopilot';
import type { CampaignPolicyDoc, MissionDoc, SteerProposal } from '../../shared/schemas';

const MAX_CYCLE_INTERVAL_HOURS = 24 * 14; // matches withPolicyDefaults

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function camelKey(k: string): string {
  return k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Deep-camelCase every object key. The proposal round-trips through the
 * frontend data shim (src/lib/caseMap.ts), which snake_cases nested keys on
 * read - so a stored proposal comes back as `target_description`/`clear_icp`.
 * This restores `targetDescription`/`clearIcp` etc. so buildSteerUpdates (which
 * reads camelCase) sees the fields. Only KEYS are touched; string values
 * (claims, fact ids, change text) are untouched.
 */
export function normalizeProposal(raw: unknown): SteerProposal {
  const deep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(deep);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[camelKey(k)] = deep(val);
      return out;
    }
    return v;
  };
  return (deep(raw ?? {}) as SteerProposal) ?? ({ changes: [] } as SteerProposal);
}

export interface SteerUpdates {
  missionUpdate: Partial<MissionDoc>;
  policyUpdate: Partial<CampaignPolicyDoc>;
}

/**
 * Build the DB field updates for a steering proposal. `mission`/`policy` are the
 * current docs (policy may be null if the mission has no autopilot policy yet);
 * `validFactIds`, when given, restricts which ids may be pinned (server passes
 * the user's own fact ids so a tampered proposal can't pin a stranger's fact).
 */
export function buildSteerUpdates(
  mission: Pick<MissionDoc, 'draftDirective' | 'emphasizedFactIds'>,
  policy: Pick<CampaignPolicyDoc, never> | null,
  proposal: SteerProposal,
  opts: { validFactIds?: Set<string> } = {}
): SteerUpdates {
  const missionUpdate: Partial<MissionDoc> = {};
  const policyUpdate: Partial<CampaignPolicyDoc> = {};

  const m = proposal.mission;
  if (m) {
    if (typeof m.goal === 'string' && m.goal.trim()) missionUpdate.goal = m.goal.trim();
    if (typeof m.targetDescription === 'string' && m.targetDescription.trim()) {
      missionUpdate.targetDescription = m.targetDescription.trim();
    }
    if (m.geo !== undefined) missionUpdate.geo = m.geo?.trim() || null;

    if (Array.isArray(m.sectors)) {
      const names = m.sectors.map((s) => String(s).trim()).filter(Boolean);
      missionUpdate.sectorSuggestions = names.length ? names.map((name) => ({ name, recommended: true })) : null;
    }

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
      // Only wipe sectors if the proposal didn't set explicit ones above.
      if (!Array.isArray(m.sectors)) missionUpdate.sectorSuggestions = null;
    }
  }

  const p = proposal.policy;
  if (p && policy) {
    if (typeof p.dailySendCap === 'number') policyUpdate.dailySendCap = clamp(Math.round(p.dailySendCap), 1, MAX_DAILY_SEND_CAP);
    if (typeof p.minConfidence === 'number') policyUpdate.minConfidence = clamp(p.minConfidence, 0, 1);
    if (typeof p.cycleIntervalHours === 'number') policyUpdate.cycleIntervalHours = clamp(Math.round(p.cycleIntervalHours), 1, MAX_CYCLE_INTERVAL_HOURS);
    if (typeof p.targetsPerCycle === 'number') policyUpdate.targetsPerCycle = clamp(Math.round(p.targetsPerCycle), 1, MAX_TARGETS_PER_CYCLE);
    if (typeof p.autoSend === 'boolean') policyUpdate.autoSend = p.autoSend;
    if (p.sendWindow && typeof p.sendWindow.startHour === 'number' && typeof p.sendWindow.endHour === 'number') {
      const startHour = clamp(Math.round(p.sendWindow.startHour), 0, 23);
      const endHour = clamp(Math.round(p.sendWindow.endHour), 1, 24);
      if (endHour > startHour) policyUpdate.sendWindow = { startHour, endHour };
    }
    if (typeof p.timezone === 'string' && p.timezone.trim()) policyUpdate.timezone = p.timezone.trim();
  }

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

  return { missionUpdate, policyUpdate };
}

/** True when a proposal would change nothing (e.g. a pure clarification). */
export function isEmptyUpdate(u: SteerUpdates): boolean {
  return Object.keys(u.missionUpdate).length === 0 && Object.keys(u.policyUpdate).length === 0;
}
