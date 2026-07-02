// Mission Recipe resolution - the single translation layer between the stored
// MissionRecipeDoc (the modular pipeline definition) and what the pipeline +
// autopilot cron actually consume. Kept side-effect-free where possible so the
// defaulting/clamping is unit testable; resolveRecipe is the one DB-touching
// entry point.
//
// Design goals:
//   • ONE source of truth. Both manual runs (api/agents/pipeline.ts) and the
//     autopilot cron (api/cron/autopilot-tick.ts) resolve the same recipe, so
//     they can't drift - the old "cron inherits the last manual run's config"
//     black box is gone.
//   • Default-equals-today. A mission with no recipe resolves to a default that
//     reproduces the pre-Phase-3 behavior exactly (see recipe.test.ts), so the
//     model can ship before anything is migrated or edited.
//   • Reuse the pure send logic. `policyView` flattens the send + verification
//     stages into the SendPolicy shape the functions in autopilot.ts already
//     take, so that gate/scheduling logic is reused unchanged.

import type { UserScope } from './db';
import { newId } from './db';
import { MAX_DAILY_SEND_CAP, POLICY_DEFAULTS, type SendPolicy } from './autopilot';
import {
  DEFAULT_TARGET_COUNT,
  DEFAULT_TOP_N,
  DEFAULT_TOP_CONTACTS,
  MAX_TOP_CONTACTS,
} from './pipeline';
import { env } from './env';
import type {
  CampaignPolicyDoc,
  MissionDoc,
  MissionRecipeDoc,
  PersonSourcingStage,
  PipelineRunDoc,
  ResearchStage,
  SendStage,
  SequencingStage,
  SourcingStage,
  VerificationStage,
} from '../../shared/schemas';
import type { FindMode, SeniorityLevel } from '../../shared/types';

const MAX_CYCLE_INTERVAL_HOURS = 24 * 14; // matches withPolicyDefaults
const MAX_TARGET_COUNT = 25; // matches startPipeline's clamp
const MAX_TOP_N = 15; // matches startPipeline's clamp
const MAX_TOUCHES = 5; // initial + up to 4 follow-ups
const DEFAULT_TOUCHES = 3; // initial + 2 follow-ups (see sequence.ts)

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function cleanStrings(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = typeof s === 'string' ? s.trim() : '';
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

const VALID_LEVELS: ReadonlySet<string> = new Set<SeniorityLevel>([
  'ic', 'senior_ic', 'lead', 'manager', 'senior_manager', 'director',
  'senior_director', 'vp', 'svp', 'cxo', 'founder',
]);

function cleanLevels(list: unknown): SeniorityLevel[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list)].filter((l): l is SeniorityLevel => VALID_LEVELS.has(l as string));
}

/** The stage fields, with defaults filled and every value clamped to sane
 *  bounds. Callers never re-validate. */
export type RecipeStages = Pick<
  MissionRecipeDoc,
  'automationEnabled' | 'sourcing' | 'verification' | 'research' | 'personSourcing' | 'sequencing' | 'send'
>;

export interface BuildRecipeInput {
  mission: Pick<MissionDoc, 'findMode'>;
  /** Legacy policy to fold into the send/verification stages, if the mission had one. */
  policy?: Partial<CampaignPolicyDoc> | null;
  /** Latest pipeline-run config, to preserve the person/sector selections the
   *  autopilot used to inherit from it. */
  priorConfig?: PipelineRunDoc['config'] | null;
  /** A partial recipe (e.g. from the DB or a steer patch) to normalize. Wins over
   *  policy/priorConfig for any field it sets. */
  partial?: Partial<RecipeStages> | null;
}

/**
 * Build a fully-defaulted, clamped set of recipe stages. Used by resolveRecipe
 * (synthesizing a default when a mission has no recipe yet), by the migration,
 * and by the steer apply path (re-normalizing after a patch). With no
 * policy/priorConfig/partial it yields the pre-Phase-3 defaults.
 */
export function buildRecipeStages(input: BuildRecipeInput): RecipeStages {
  const { mission, policy, priorConfig, partial } = input;
  const p = partial ?? {};
  const findMode: FindMode = p.sourcing?.findMode ?? mission.findMode ?? 'companies';

  // Sourcing counts: mirror the old mapping. targetsPerCycle drove topN and the
  // (max'd) targetCount; a prior manual run could raise targetCount.
  const targetsPerCycle = policy?.targetsPerCycle;
  const priorCount = priorConfig?.targetCount;
  const defaultCount = Math.max(targetsPerCycle ?? 0, priorCount ?? 0, DEFAULT_TARGET_COUNT);
  const defaultTopN = targetsPerCycle ?? priorConfig?.topN ?? DEFAULT_TOP_N;

  const sourcing: RecipeStages['sourcing'] = {
    type: 'sourcing',
    enabled: p.sourcing?.enabled ?? true,
    provider: p.sourcing?.provider ?? 'web_search',
    findMode,
    count: clamp(Math.round(p.sourcing?.count ?? defaultCount), 1, MAX_TARGET_COUNT),
    topN: clamp(Math.round(p.sourcing?.topN ?? defaultTopN), 1, MAX_TOP_N),
    sectors: cleanStrings(p.sourcing?.sectors ?? priorConfig?.selectedSectors),
  };

  const verification: RecipeStages['verification'] = {
    type: 'verification',
    enabled: p.verification?.enabled ?? true,
    emailVerify: p.verification?.emailVerify ?? true,
    contactVerify: p.verification?.contactVerify ?? env.CONTACT_VERIFY_ENABLED(),
    minConfidence: clamp(p.verification?.minConfidence ?? policy?.minConfidence ?? POLICY_DEFAULTS.minConfidence, 0, 1),
  };

  const research: RecipeStages['research'] = {
    type: 'research',
    enabled: p.research?.enabled ?? true,
    evidence: p.research?.evidence ?? true,
    companyEnrich: p.research?.companyEnrich ?? true,
  };

  // People mode pursues exactly one person per target (mirrors startPipeline).
  const defaultContacts = findMode === 'people' ? 1 : priorConfig?.topContacts ?? DEFAULT_TOP_CONTACTS;
  const personSourcing: RecipeStages['personSourcing'] = {
    type: 'personSourcing',
    enabled: p.personSourcing?.enabled ?? true,
    contactsPerCompany:
      findMode === 'people'
        ? 1
        : clamp(Math.round(p.personSourcing?.contactsPerCompany ?? defaultContacts), 1, MAX_TOP_CONTACTS),
    functions: cleanStrings(p.personSourcing?.functions ?? priorConfig?.selectedFunctions),
    seniority: cleanLevels(p.personSourcing?.seniority ?? priorConfig?.selectedSeniority),
  };

  const sequencing: RecipeStages['sequencing'] = {
    type: 'sequencing',
    enabled: p.sequencing?.enabled ?? true,
    touches: clamp(Math.round(p.sequencing?.touches ?? DEFAULT_TOUCHES), 1, MAX_TOUCHES),
  };

  const ps = p.send;
  const send: SendStage = {
    type: 'send',
    enabled: ps?.enabled ?? true,
    autoSend: ps?.autoSend ?? policy?.autoSend ?? POLICY_DEFAULTS.autoSend,
    cycleIntervalHours: clamp(
      Math.round(ps?.cycleIntervalHours ?? policy?.cycleIntervalHours ?? POLICY_DEFAULTS.cycleIntervalHours),
      1,
      MAX_CYCLE_INTERVAL_HOURS
    ),
    dailySendCap: clamp(
      Math.round(ps?.dailySendCap ?? policy?.dailySendCap ?? POLICY_DEFAULTS.dailySendCap),
      1,
      MAX_DAILY_SEND_CAP
    ),
    sendWindow: normalizeWindow(ps?.sendWindow ?? policy?.sendWindow) ?? { ...POLICY_DEFAULTS.sendWindow },
    timezone: (ps?.timezone ?? policy?.timezone ?? POLICY_DEFAULTS.timezone).trim() || POLICY_DEFAULTS.timezone,
    lastSourcedAt: ps?.lastSourcedAt ?? policy?.lastSourcedAt ?? null,
    counter: ps?.counter ?? policy?.counter ?? null,
  };

  const automationEnabled = p.automationEnabled ?? policy?.enabled ?? false;

  return { automationEnabled, sourcing, verification, research, personSourcing, sequencing, send };
}

function normalizeWindow(w: { startHour?: number; endHour?: number } | undefined | null): { startHour: number; endHour: number } | null {
  if (!w || typeof w.startHour !== 'number' || typeof w.endHour !== 'number') return null;
  const startHour = clamp(Math.round(w.startHour), 0, 23);
  const endHour = clamp(Math.round(w.endHour), 1, 24);
  return endHour > startHour ? { startHour, endHour } : null;
}

/** Flatten a recipe's send + verification stages into the SendPolicy shape the
 *  pure send/scheduling logic in autopilot.ts consumes. */
export function policyView(recipe: Pick<RecipeStages, 'automationEnabled' | 'send' | 'verification'>): SendPolicy {
  return {
    enabled: recipe.automationEnabled,
    autoSend: recipe.send.autoSend,
    cycleIntervalHours: recipe.send.cycleIntervalHours,
    lastSourcedAt: recipe.send.lastSourcedAt,
    dailySendCap: recipe.send.dailySendCap,
    sendWindow: recipe.send.sendWindow,
    timezone: recipe.send.timezone,
    minConfidence: recipe.verification.minConfidence,
    counter: recipe.send.counter,
  };
}

/** The pipeline-run config a recipe produces - the shape startPipeline + the
 *  pipeline driver consume. */
export function pipelineConfigFromRecipe(recipe: RecipeStages): {
  targetCount: number;
  topN: number;
  topContacts: number;
  findMode: FindMode;
  selectedFunctions: string[];
  selectedSeniority: SeniorityLevel[];
  selectedSectors: string[];
} {
  return {
    targetCount: recipe.sourcing.count,
    topN: recipe.sourcing.topN,
    topContacts: recipe.personSourcing.contactsPerCompany,
    findMode: recipe.sourcing.findMode,
    selectedFunctions: recipe.personSourcing.functions,
    selectedSeniority: recipe.personSourcing.seniority,
    selectedSectors: recipe.sourcing.sectors,
  };
}

/**
 * Load a mission's recipe, synthesizing (and NOT persisting) a defaulted one
 * when it has none yet - so every mission resolves to something usable before
 * the migration runs or the user edits anything. Reads the legacy policy +
 * latest run config to reproduce the pre-Phase-3 behavior for un-migrated
 * missions. Returns the recipe doc fields (defaulted + clamped).
 */
export async function resolveRecipe(scope: UserScope, missionId: string): Promise<RecipeStages> {
  const existing = await scope.collection<MissionRecipeDoc>('mission_recipes').findOne({ missionId });
  if (existing) {
    // Re-normalize on read so a partial/legacy stored doc still reads complete.
    return buildRecipeStages({ mission: { findMode: existing.sourcing?.findMode }, partial: existing });
  }
  const mission = await scope.collection<MissionDoc>('missions').findById(missionId);
  const policy = await scope.collection<CampaignPolicyDoc>('campaign_policies').findOne({ missionId });
  const priorConfig = latestRunConfig(
    (await scope.collection<PipelineRunDoc>('pipeline_runs').find({ missionId } as never)) as PipelineRunDoc[]
  );
  return buildRecipeStages({ mission: { findMode: mission?.findMode ?? null }, policy, priorConfig });
}

function latestRunConfig(runs: PipelineRunDoc[]): PipelineRunDoc['config'] | null {
  if (runs.length === 0) return null;
  return [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0].config ?? null;
}

/** Persist a fresh recipe doc for a mission (migration + first-write path). */
export async function insertRecipe(scope: UserScope, missionId: string, stages: RecipeStages): Promise<MissionRecipeDoc> {
  return (await scope
    .collection<MissionRecipeDoc>('mission_recipes')
    .insertOne({ _id: newId(), missionId, ...stages } as never)) as MissionRecipeDoc;
}

/** A partial edit over a recipe's stages - what the steer agent proposes. Each
 *  stage is independently patchable; only the fields the instruction implies are
 *  set. Clamping/validation happens in applyRecipePatch (via buildRecipeStages). */
export interface RecipeStagesPatch {
  automationEnabled?: boolean;
  sourcing?: Partial<SourcingStage>;
  verification?: Partial<VerificationStage>;
  research?: Partial<ResearchStage>;
  personSourcing?: Partial<PersonSourcingStage>;
  sequencing?: Partial<SequencingStage>;
  send?: Partial<SendStage>;
}

/** True when a patch would change nothing. */
export function isEmptyRecipePatch(p: RecipeStagesPatch): boolean {
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

/**
 * Merge a stage patch onto the current recipe and re-clamp the result. Each
 * stage is shallow-merged (stages are flat), then the whole thing runs back
 * through buildRecipeStages so every numeric is clamped + every list cleaned -
 * the same safety layer that runs on a fresh build, so a tampered patch can't
 * push a value out of bounds.
 */
export function applyRecipePatch(current: RecipeStages, patch: RecipeStagesPatch): RecipeStages {
  const merged: Partial<RecipeStages> = {
    automationEnabled: patch.automationEnabled ?? current.automationEnabled,
    sourcing: { ...current.sourcing, ...patch.sourcing },
    verification: { ...current.verification, ...patch.verification },
    research: { ...current.research, ...patch.research },
    personSourcing: { ...current.personSourcing, ...patch.personSourcing },
    sequencing: { ...current.sequencing, ...patch.sequencing },
    send: { ...current.send, ...patch.send },
  };
  return buildRecipeStages({ mission: { findMode: merged.sourcing?.findMode ?? null }, partial: merged });
}

/** Insert or update a mission's recipe doc with the given (already-clamped) stages. */
export async function upsertRecipe(scope: UserScope, missionId: string, stages: RecipeStages): Promise<void> {
  const existing = await scope.collection<MissionRecipeDoc>('mission_recipes').findOne({ missionId });
  if (existing) {
    await scope.collection<MissionRecipeDoc>('mission_recipes').updateById(existing._id, stages as never);
  } else {
    await insertRecipe(scope, missionId, stages);
  }
}
