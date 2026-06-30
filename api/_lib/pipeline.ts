// Durable, resumable, *parallel* pipeline orchestration - the server-side
// replacement for the old browser-driven run (which executed ~16 agent calls in
// the tab and died on close).
//
// Design:
//   • The `pipeline_runs` doc is the single source of truth for progress. Each
//     target carries its own step statuses (evidence/contacts/sequence and the
//     per-contact `sequences[]`), so progress is tracked per-target rather than
//     through a single cursor.
//   • Targets are independent: a target's research/draft work never depends on
//     another target's. So the driver fans out across targets with *bounded*
//     concurrency. Within one target, evidence + contacts run concurrently (the
//     "research" phase - contacts never reads the evidence pack; only the draft
//     step needs both), then the contact drafts overlap. So we parallelize both
//     across targets and within each target's independent work.
//   • Concurrency is bounded and launches are staggered. The per-minute LLM
//     quota and the (non-atomic) daily run cap in runs.ts both punish bursts, so
//     we keep a small pool and start workers a beat apart.
//   • Every transition persists and writes a heartbeat, so a dropped connection
//     or a restarted instance loses nothing - any later poll re-drives the run,
//     and because each step keys off the target's persisted status the work is
//     idempotent on resume (`resumeIfStale`), down to re-running only the one
//     research sub-step that a rate limit left unfinished.

import { forUser, newId, type UserScope } from './db';
import type { AuthedUser } from './auth';
import { invokeAgent } from './internal-invoke';
import { getPlanLimits } from './runs';
import { createDraftContextCache } from './assemble';
import type {
  AgentRunDoc,
  MissionDoc,
  PipelineRunDoc,
  PipelineRunMetrics,
  PipelineStepStatus,
  PipelineTargetState,
  TargetDoc,
} from '../../shared/schemas';
import type { ContactTypeFilter, FindMode, SeniorityLevel } from '../../shared/types';

import targetHandler from '../agents/target';
import peopleHandler from '../agents/people';
import evidenceHandler from '../agents/evidence';
import contactsHandler from '../agents/contacts';
import sequenceHandler from '../agents/sequence';

export const DEFAULT_TARGET_COUNT = 8;
export const DEFAULT_TOP_N = 5;
export const DEFAULT_TOP_CONTACTS = 1;
export const MAX_TOP_CONTACTS = 5;

// How many targets run at once. Derived per-run from the plan's per-minute cap
// (with headroom) and clamped to this ceiling so a generous plan can't burst the
// LLM quota or badly overshoot the daily cap.
// Safe to raise: the real quota guard is runs.ts:checkRateLimit (per-minute and
// per-day caps), and runStep retries/pauses on those - so concurrency only sets
// how hard we push toward the cap, never past it.
export const DEFAULT_PIPELINE_CONCURRENCY = 4;
export const MAX_PIPELINE_CONCURRENCY = 8;
// Drafts overlapped within a single target (topContacts is small).
const CONTACT_CONCURRENCY = 3;
// Ceiling on how many backup companies a single run will pull in to replace
// ones that yield no reachable contact. Bounds re-discovery cost and guarantees
// the replenish loop terminates even if every backup also comes up empty.
const MAX_REPLACEMENTS = 12;
// Beat between starting successive target workers, to desynchronize the
// count-then-insert in runs.ts:checkRateLimit (bounds daily-cap overshoot).
const LAUNCH_STAGGER_MS = 200;

const MINUTE_RETRY_WAIT_MS = 35_000;
const MINUTE_RETRY_MAX = 2;
export const STALE_HEARTBEAT_MS = 90_000; // older than this ⇒ driver is dead

// ---------------------------------------------------------------------------
// Typed errors so a step can tell "wait a minute" from "stop for today".
// ---------------------------------------------------------------------------
export class PipelineRateLimitError extends Error {} // per-minute: retryable
export class PipelineDailyLimitError extends Error {
  // ISO timestamp when the rolling daily window frees up, surfaced from the 429
  // body so the paused run can tell the user a specific resume time.
  resetAt: string | null;
  constructor(message: string, resetAt: string | null = null) {
    super(message);
    this.resetAt = resetAt;
  }
} // per-day: pause the run

// ---------------------------------------------------------------------------
// Executors - the side-effecting calls the driver runs. Real ones reuse the
// existing agent handlers verbatim via in-process invocation; tests pass fakes.
// ---------------------------------------------------------------------------
export interface PipelineExecutors {
  /** Discover the run's targets. In 'companies' mode this finds companies; in
   *  'people' mode it finds people directly (each becomes a target). `functions`
   *  and `seniority` only narrow people discovery (company mode ignores them). */
  targeting(
    missionId: string,
    count: number,
    sectors?: string[],
    functions?: string[],
    seniority?: SeniorityLevel[]
  ): Promise<Array<{ id: string; name: string; score: number | null }>>;
  evidence(targetId: string): Promise<void>;
  contacts(targetId: string, filter?: ContactTypeFilter, topContacts?: number): Promise<Array<{ id: string; confidence: number | null }>>;
  sequence(contactId: string): Promise<void>;
  /** Already-discovered companies not yet in the run, ranked by score - the
   *  over-discovery "reserve" we pull from when a company yields no contact.
   *  `excludeIds` are targets already in the run. */
  reserve(missionId: string, excludeIds: string[]): Promise<Array<{ id: string; name: string; score: number | null }>>;
  /** Drop a company from the user-facing output (no deliverable contact found). */
  markRejected(targetId: string): Promise<void>;
  /** Promote a target that produced a draft out of the 'suggested' pool so a
   *  later re-run never pulls it back in as reserve (and never re-rejects it). */
  markCompleted(targetId: string): Promise<void>;
}

function classify<T = Record<string, unknown>>(result: { status: number; body: unknown }): T {
  const body = (result.body ?? {}) as Record<string, unknown>;
  if (result.status === 429) {
    const detail = String(body.detail ?? body.error ?? '');
    if (/daily/i.test(detail)) {
      const resetAt = typeof body.resetAt === 'string' ? body.resetAt : null;
      throw new PipelineDailyLimitError(detail || 'daily_limit', resetAt);
    }
    throw new PipelineRateLimitError(detail || 'rate_limit');
  }
  if (result.status >= 400) {
    throw new Error(String(body.detail ?? body.error ?? `status_${result.status}`));
  }
  return body as T;
}

export function realExecutors(user: AuthedUser): PipelineExecutors {
  const draftContextCache = createDraftContextCache();
  return {
    async targeting(missionId, count, sectors, functions, seniority) {
      const scope = forUser(user.id);
      const mission = await scope.collection<MissionDoc>('missions').findById(missionId);
      // People mode: find people directly. Each returned target carries the
      // person in `seedContact`; show the PERSON's name in the run, not the firm.
      if (mission?.findMode === 'people') {
        const result = await invokeAgent(peopleHandler, { user, body: { mission_id: missionId, count, sectors, functions, seniority } });
        if (isNoResults(result)) return []; // nothing new to add - finish gracefully, don't error
        const body = classify<{
          targets?: Array<{ _id: string; companyName: string; score: number | null; seedContact?: { name?: string } | null }>;
        }>(result);
        return (body.targets ?? []).map((t) => ({ id: t._id, name: t.seedContact?.name ?? t.companyName, score: t.score ?? null }));
      }
      const result = await invokeAgent(targetHandler, { user, body: { mission_id: missionId, count, sectors } });
      if (isNoResults(result)) return [];
      const body = classify<{ targets?: Array<{ _id: string; companyName: string; score: number | null }> }>(result);
      return (body.targets ?? []).map((t) => ({ id: t._id, name: t.companyName, score: t.score ?? null }));
    },
    async evidence(targetId) {
      classify(await invokeAgent(evidenceHandler, { user, body: { target_id: targetId } }));
    },
    async contacts(targetId, filter, topContacts) {
      const body = classify<{ contacts?: Array<{ _id: string; confidence: number | null }> }>(
        await invokeAgent(contactsHandler, {
          user,
          body: { target_id: targetId, contact_type_filter: filter, top_contacts: topContacts },
        })
      );
      return (body.contacts ?? []).map((c) => ({ id: c._id, confidence: c.confidence ?? null }));
    },
    async sequence(contactId) {
      classify(await invokeAgent(sequenceHandler, { user, body: { contact_id: contactId, draft_context_cache: draftContextCache } }));
    },
    async reserve(missionId, excludeIds) {
      const scope = forUser(user.id);
      const exclude = new Set(excludeIds);
      // The targeting agent over-discovers and inserts the whole pool as
      // 'suggested'; the ones we never seeded are our backup bench. Completed
      // targets are promoted to 'approved' (see markCompleted), so this query
      // never re-pulls a prior run's finished work.
      const all = await scope.collection<TargetDoc>('targets').find({ missionId, status: 'suggested' });
      return all
        .filter((t) => !exclude.has(t._id))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        // People targets carry the person in seedContact; show them, not the firm.
        .map((t) => ({ id: t._id, name: t.seedContact?.name ?? t.companyName, score: t.score ?? null }));
    },
    async markRejected(targetId) {
      const scope = forUser(user.id);
      await scope.collection<TargetDoc>('targets').updateById(targetId, { status: 'rejected' } as Partial<TargetDoc>);
    },
    async markCompleted(targetId) {
      const scope = forUser(user.id);
      await scope.collection<TargetDoc>('targets').updateById(targetId, { status: 'approved' } as Partial<TargetDoc>);
    },
  };
}

/** A no-results agent response (502 no_people_found / no_targets_found). Not a
 *  failure: the search ran, it just had nothing NEW to add (common on a re-run).
 *  We treat it as an empty result so the run finishes calmly rather than erroring. */
export function isNoResults(result: { status: number; body: unknown }): boolean {
  if (result.status !== 502) return false;
  const body = (result.body ?? {}) as Record<string, unknown>;
  const code = String(body.error ?? body.detail ?? '');
  return code === 'no_people_found' || code === 'no_targets_found';
}

// ---------------------------------------------------------------------------
// The parallel processor. `runPipeline` advances a run to a terminal/paused
// state, mutating a *copy* of the input (callers persist via the context). No
// Mongo lives here, so it is unit-testable with fake executors + fake persist.
// ---------------------------------------------------------------------------
const HALTED: ReadonlySet<PipelineRunDoc['status']> = new Set(['paused', 'done', 'error', 'canceled']);

/** Driver-supplied side effects + shared run flags. */
export interface ProcContext {
  exec: PipelineExecutors;
  /** Max targets in flight at once. */
  concurrency: number;
  /** Max contact-drafts in flight within one target. */
  contactConcurrency?: number;
  /** Delay between starting successive target workers. */
  launchStaggerMs?: number;
  minuteRetryMax?: number;
  minuteRetryWaitMs?: number;
  /** Set true when any step hits the per-day cap; stops new work. */
  paused: boolean;
  /** ISO time the rolling daily window frees up, captured from the daily-limit
   *  error so the paused run can show a specific resume time. */
  dailyResetAt?: string | null;
  /** Set true when an external cancel is observed; stops new work. */
  canceled: boolean;
  /** Persist target/note progress (never status) - safe to race with cancel. */
  persist: (run: PipelineRunDoc) => Promise<void>;
  /** Persist a status transition (running/paused/done/error). */
  persistStatus: (run: PipelineRunDoc) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Optional: re-read the run to notice an external cancel. */
  checkCanceled?: () => Promise<boolean>;
}

function step(t: PipelineTargetState, key: 'evidence' | 'contacts' | 'sequence', s: PipelineStepStatus) {
  t[key] = s;
}

const isResolved = (s: PipelineStepStatus) => s === 'done' || s === 'failed';

// Pick the contacts we draft for: top `topContacts` by reply-likelihood. Stored
// on the target as soon as contacts resolves so the selection survives a partial
// 'research' retry (when evidence rate-limits but contacts already succeeded).
function selectContacts(
  t: PipelineTargetState,
  contacts: Array<{ id: string; confidence: number | null }>,
  topContacts: number,
): void {
  const ranked = [...contacts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  t.contactIds = ranked.slice(0, Math.max(1, topContacts)).map((c) => c.id);
  t.bestContactId = t.contactIds[0] ?? null;
  t.sequences = t.contactIds.map(() => 'queued');
}

function finishProcessing(r: PipelineRunDoc): PipelineRunDoc {
  r.phase = 'done';
  r.status = 'done';
  r.cursor = null;
  r.note = null;
  r.dailyResetAt = null; // cleared: a finished run has no pending reset
  r.completedAt = new Date();
  markTotalMs(r);
  return r;
}

function pauseForDaily(r: PipelineRunDoc, ctx?: ProcContext): PipelineRunDoc {
  r.status = 'paused';
  r.cursor = null;
  // The rolling-window reset time (when known) so the client can show a specific
  // resume time instead of a vague "tomorrow".
  const resetAt = ctx?.dailyResetAt ?? null;
  r.dailyResetAt = resetAt ? new Date(resetAt) : null;
  r.note = resetAt
    ? 'Daily agent-run limit reached - finished targets are ready; the rest resume automatically once your limit resets.'
    : 'Daily agent-run limit reached - finished targets are ready; the rest resume when your limit resets.';
  return r; // per-target statuses preserved so a later run resumes exactly here
}

/** Record a per-day pause: stop new work and capture the reset time (if the
 *  error carried one) so the run can report a specific resume time. */
function recordDailyPause(ctx: ProcContext, e: PipelineDailyLimitError): void {
  ctx.paused = true;
  if (e.resetAt) ctx.dailyResetAt = e.resetAt;
}

/** A target is finished once its aggregate draft status is terminal; every
 *  failure path cascades to sequence='failed', so this single field decides it. */
function targetTerminal(t: PipelineTargetState): boolean {
  return t.sequence === 'done' || t.sequence === 'failed';
}

function progressNote(r: PipelineRunDoc): string {
  const total = r.targets.length;
  const done = r.targets.filter(targetTerminal).length;
  return `Researched ${done} of ${total} ${unitNoun(r)}…`;
}

/** "companies" / "people" for user-facing run copy, per the run's find mode. */
function unitNoun(r: PipelineRunDoc): string {
  return r.config.findMode === 'people' ? 'people' : 'companies';
}

function cloneRun(run: PipelineRunDoc): PipelineRunDoc {
  return {
    ...run,
    targets: run.targets.map((t) => ({ ...t, contactIds: [...t.contactIds], sequences: [...t.sequences] })),
    metrics: cloneMetrics(run.metrics),
    cursor: null,
  };
}

function cloneMetrics(metrics: PipelineRunMetrics | undefined): PipelineRunMetrics | undefined {
  if (!metrics) return undefined;
  return {
    ...metrics,
    agentMs: { ...(metrics.agentMs ?? {}) },
    agentCalls: { ...(metrics.agentCalls ?? {}) },
  };
}

function metrics(r: PipelineRunDoc): PipelineRunMetrics {
  if (!r.metrics) r.metrics = {};
  return r.metrics;
}

function addMetricMs(r: PipelineRunDoc, key: 'targetingMs' | 'processingMs' | 'replacementMs', ms: number): void {
  const m = metrics(r);
  m[key] = Math.round((m[key] ?? 0) + ms);
}

function addAgentTiming(r: PipelineRunDoc, agentType: AgentRunDoc['agentType'], ms: number): void {
  const m = metrics(r);
  m.agentMs = { ...(m.agentMs ?? {}), [agentType]: Math.round(((m.agentMs ?? {})[agentType] ?? 0) + ms) };
  m.agentCalls = { ...(m.agentCalls ?? {}), [agentType]: ((m.agentCalls ?? {})[agentType] ?? 0) + 1 };
}

async function measureMs<T>(r: PipelineRunDoc, key: 'targetingMs' | 'processingMs' | 'replacementMs', fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    addMetricMs(r, key, Date.now() - start);
  }
}

async function measureAgent<T>(r: PipelineRunDoc, agentType: AgentRunDoc['agentType'], fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    addAgentTiming(r, agentType, Date.now() - start);
  }
}

function markFirstDraft(r: PipelineRunDoc): void {
  const m = metrics(r);
  if (!m.firstDraftAt) m.firstDraftAt = new Date();
}

function markTotalMs(r: PipelineRunDoc): void {
  if (!r.completedAt || !r.startedAt) return;
  const startedAt = new Date(r.startedAt).getTime();
  const completedAt = new Date(r.completedAt).getTime();
  if (Number.isFinite(startedAt) && Number.isFinite(completedAt)) metrics(r).totalMs = Math.max(0, completedAt - startedAt);
}

/** Run one step, retrying a few times on a per-minute rate limit. Re-throws the
 *  rate-limit error if retries are exhausted (caller marks the step failed) and
 *  bubbles a daily-limit error immediately (caller pauses the run). */
async function runStep<T>(ctx: ProcContext, fn: () => Promise<T>): Promise<T> {
  const maxRetries = ctx.minuteRetryMax ?? MINUTE_RETRY_MAX;
  const waitMs = ctx.minuteRetryWaitMs ?? MINUTE_RETRY_WAIT_MS;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PipelineRateLimitError) {
        if (++attempt > maxRetries) throw e;
        await ctx.sleep(waitMs);
        if (ctx.paused || ctx.canceled) throw e; // halted while waiting - give up
        continue;
      }
      throw e;
    }
  }
}

const halted = (ctx: ProcContext) => ctx.paused || ctx.canceled;

/** Run the evidence sub-step, recording its terminal status on the target. */
async function runEvidence(r: PipelineRunDoc, t: PipelineTargetState, ctx: ProcContext): Promise<void> {
  try {
    await measureAgent(r, 'evidence', () => runStep(ctx, () => ctx.exec.evidence(t.targetId)));
    step(t, 'evidence', 'done');
  } catch (e) {
    if (e instanceof PipelineDailyLimitError) {
      recordDailyPause(ctx, e);
      step(t, 'evidence', 'queued'); // revert so resume re-runs only this sub-step
      return;
    }
    step(t, 'evidence', 'failed');
  }
}

/** Run the contacts sub-step, recording status + the pursued-contact selection. */
async function runContacts(r: PipelineRunDoc, t: PipelineTargetState, ctx: ProcContext): Promise<void> {
  try {
    const filter: ContactTypeFilter = {
      functions: r.config.selectedFunctions ?? [],
      seniority: r.config.selectedSeniority ?? [],
    };
    const contacts = await measureAgent(r, 'contacts', () =>
      runStep(ctx, () => ctx.exec.contacts(t.targetId, filter, r.config.topContacts))
    );
    step(t, 'contacts', 'done');
    selectContacts(t, contacts, r.config.topContacts);
  } catch (e) {
    if (e instanceof PipelineDailyLimitError) {
      recordDailyPause(ctx, e);
      step(t, 'contacts', 'queued');
      return;
    }
    step(t, 'contacts', 'failed');
  }
}

/** Process ONE target: research (evidence + contacts concurrent) → drafts.
 *  Resumes from whatever its persisted statuses already say is done; mutates `t`
 *  in place and persists after each transition. Sets ctx.paused on a daily-limit
 *  so the pool drains. */
async function processTarget(
  r: PipelineRunDoc,
  t: PipelineTargetState,
  ctx: ProcContext,
  onDropped?: () => Promise<void>
): Promise<void> {
  // --- research: evidence + contacts run concurrently (independent work) ---
  if (!isResolved(t.evidence) || !isResolved(t.contacts)) {
    if (halted(ctx)) return;
    if (!isResolved(t.evidence)) step(t, 'evidence', 'running');
    if (!isResolved(t.contacts)) step(t, 'contacts', 'running');
    await ctx.persist(r);

    const subs: Array<Promise<void>> = [];
    if (!isResolved(t.evidence)) subs.push(runEvidence(r, t, ctx));
    if (!isResolved(t.contacts)) subs.push(runContacts(r, t, ctx));
    await Promise.all(subs);
    await ctx.persist(r);

    if (halted(ctx)) return; // a sub-step hit the daily cap and reverted to queued

    // Evidence is the precondition for drafting (the draft step needs the pack),
    // so a failed evidence fails the whole target.
    if (t.evidence === 'failed') {
      step(t, 'contacts', 'failed');
      step(t, 'sequence', 'failed');
      await dropTarget(t, ctx);
      r.note = progressNote(r);
      await ctx.persist(r);
      await onDropped?.();
      return;
    }
    if (t.contacts === 'failed' || t.contactIds.length === 0) {
      step(t, 'sequence', 'failed');
      await dropTarget(t, ctx);
      r.note = progressNote(r);
      await ctx.persist(r);
      await onDropped?.();
      return;
    }
  }

  // --- sequence: draft each pursued contact, a couple at a time ---
  if (t.sequence !== 'done') {
    if (halted(ctx)) return;
    step(t, 'sequence', 'running');
    await ctx.persist(r);
    const pending = t.contactIds.map((_, i) => i).filter((i) => t.sequences[i] !== 'done');
    await mapPool(pending, ctx.contactConcurrency ?? CONTACT_CONCURRENCY, async (i) => {
      if (halted(ctx)) return;
      t.sequences[i] = 'running';
      await ctx.persist(r);
      try {
        await measureAgent(r, 'sequence', () => runStep(ctx, () => ctx.exec.sequence(t.contactIds[i])));
        t.sequences[i] = 'done';
        markFirstDraft(r);
      } catch (e) {
        if (e instanceof PipelineDailyLimitError) {
          recordDailyPause(ctx, e);
          t.sequences[i] = 'queued';
          await ctx.persist(r);
          return;
        }
        t.sequences[i] = 'failed';
      }
      await ctx.persist(r);
    });
    if (halted(ctx)) {
      // Leave the aggregate non-terminal so a resume re-enters this step and
      // redraws only the still-queued contacts.
      step(t, 'sequence', 'queued');
      await ctx.persist(r);
      return;
    }
    const drafted = t.sequences.some((s) => s === 'done');
    step(t, 'sequence', drafted ? 'done' : 'failed');
    // A delivered target leaves the 'suggested' pool so a later re-run treats it
    // as finished work, not reserve to re-process (and possibly reject).
    if (drafted) await completeTarget(t, ctx);
    r.note = progressNote(r);
    await ctx.persist(r);
  }
}

/** Bounded-concurrency map over a list, no result collection. */
async function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
}

interface ReplacementState {
  added: number;
  chain: Promise<void>;
}

function replacementState(): ReplacementState {
  return { added: 0, chain: Promise.resolve() };
}

/** Targets that have not conclusively failed from missing research/contact data.
 *  Queued replacements count as viable so concurrent failures don't overfill
 *  the run while those replacements are still being processed. */
function viableProspectCount(r: PipelineRunDoc): number {
  return r.targets.filter((t) => !(t.sequence === 'failed' && (t.contacts === 'failed' || t.contactIds.length === 0))).length;
}

function replacementNeed(r: PipelineRunDoc): number {
  return Math.max(0, r.config.topN - viableProspectCount(r));
}

async function appendReplacementTargets(
  r: PipelineRunDoc,
  ctx: ProcContext,
  state: ReplacementState
): Promise<PipelineTargetState[]> {
  if (halted(ctx) || state.added >= MAX_REPLACEMENTS) return [];
  const need = replacementNeed(r);
  if (need <= 0) return [];

  const have = new Set(r.targets.map((t) => t.targetId));
  let candidates: Array<{ id: string; name: string; score: number | null }> = [];
  await measureMs(r, 'replacementMs', async () => {
    try {
      candidates = await ctx.exec.reserve(r.missionId, [...have]);
    } catch (err) {
      console.warn('reserve_lookup_failed', r.missionId, err);
    }

    if (candidates.length === 0) {
      // Reserve exhausted → discover a fresh batch (the agent already excludes
      // companies already targeted in this mission), then keep going.
      try {
        const found = await measureAgent(r, 'targeting', () =>
          runStep(ctx, () =>
            ctx.exec.targeting(
              r.missionId,
              r.config.targetCount,
              r.config.selectedSectors,
              r.config.selectedFunctions,
              r.config.selectedSeniority
            )
          )
        );
        candidates = found.filter((f) => !have.has(f.id));
      } catch (e) {
        if (e instanceof PipelineDailyLimitError) recordDailyPause(ctx, e);
        candidates = [];
      }
    }
  });
  if (halted(ctx) || candidates.length === 0) return [];

  const room = MAX_REPLACEMENTS - state.added;
  const picks = [...candidates]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, Math.min(need, room));
  if (picks.length === 0) return [];

  const fresh = seedTargets(picks, picks.length);
  r.targets.push(...fresh);
  state.added += fresh.length;
  r.note = `Some had no reachable contact, finding fresh ${unitNoun(r)}…`;
  await ctx.persist(r);
  return fresh;
}

async function serializedReplacement(
  r: PipelineRunDoc,
  ctx: ProcContext,
  state: ReplacementState,
  onFresh: (targets: PipelineTargetState[]) => void
): Promise<void> {
  const run = async () => {
    if (await observeCancel(ctx)) return;
    const fresh = await appendReplacementTargets(r, ctx, state);
    if (fresh.length > 0) onFresh(fresh);
  };
  state.chain = state.chain.then(run, run);
  await state.chain;
}

/** Pull non-terminal targets through `processTarget` with bounded concurrency,
 *  starting workers a beat apart and stopping early on pause/cancel. */
async function runTargetPool(r: PipelineRunDoc, ctx: ProcContext, replacements: ReplacementState): Promise<void> {
  const queue = r.targets.filter((t) => !targetTerminal(t));
  if (queue.length === 0) return;
  let next = 0;
  const stagger = ctx.launchStaggerMs ?? LAUNCH_STAGGER_MS;
  const n = Math.max(1, Math.min(ctx.concurrency, queue.length));

  const worker = async (workerIndex: number) => {
    if (workerIndex > 0 && stagger) await ctx.sleep(workerIndex * stagger);
    for (;;) {
      if (ctx.paused) return;
      if (await observeCancel(ctx)) return;
      const i = next++;
      if (i >= queue.length) return;
      await processTarget(r, queue[i], ctx, () => serializedReplacement(r, ctx, replacements, (fresh) => queue.push(...fresh)));
    }
  };
  await Promise.all(Array.from({ length: n }, (_, w) => worker(w)));
  await replacements.chain;
}

async function observeCancel(ctx: ProcContext): Promise<boolean> {
  if (ctx.canceled) return true;
  if (ctx.checkCanceled && (await ctx.checkCanceled())) ctx.canceled = true;
  return ctx.canceled;
}

/** Drop a company that produced no deliverable contact from the user-facing
 *  output. Best-effort: a lingering empty card is tolerable, a crashed run isn't. */
async function dropTarget(t: PipelineTargetState, ctx: ProcContext): Promise<void> {
  try {
    await ctx.exec.markRejected(t.targetId);
  } catch (err) {
    console.warn('mark_rejected_failed', t.targetId, err);
  }
}

/** Promote a delivered target out of the 'suggested' reserve pool. Best-effort:
 *  a missed promotion only costs a redundant re-process on a later run. */
async function completeTarget(t: PipelineTargetState, ctx: ProcContext): Promise<void> {
  try {
    await ctx.exec.markCompleted(t.targetId);
  } catch (err) {
    console.warn('mark_completed_failed', t.targetId, err);
  }
}

/** Final safety net for runs resumed from older state or for replacement misses
 *  that happened after all original workers drained. The main pool now replaces
 *  continuously as targets fail, so this usually exits immediately. */
async function replenishTargets(r: PipelineRunDoc, ctx: ProcContext, replacements: ReplacementState): Promise<void> {
  while (!halted(ctx) && replacementNeed(r) > 0 && replacements.added < MAX_REPLACEMENTS) {
    if (await observeCancel(ctx)) return;
    const fresh = await appendReplacementTargets(r, ctx, replacements);
    if (fresh.length === 0) return;
    await runTargetPool(r, ctx, replacements);
  }
}

function seedTargets(found: Array<{ id: string; name: string; score: number | null }>, topN: number): PipelineTargetState[] {
  const top = [...found].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topN);
  return top.map((t) => ({
    targetId: t.id,
    name: t.name,
    score: t.score,
    evidence: 'queued',
    contacts: 'queued',
    sequence: 'queued',
    contactIds: [],
    sequences: [],
    bestContactId: null,
  }));
}

/**
 * Advance a run to a terminal (done/error) or paused state. Targeting runs once,
 * then the processing pool fans out across targets. Operates on a copy; the
 * context's persist callbacks are the only writers.
 */
export async function runPipeline(run: PipelineRunDoc, ctx: ProcContext): Promise<PipelineRunDoc> {
  const r = cloneRun(run);
  if (HALTED.has(r.status)) return r;
  const replacements = replacementState();

  // --- targeting ---
  if (r.phase === 'targeting') {
    r.status = 'running';
    try {
      const found = await measureMs(r, 'targetingMs', () =>
        measureAgent(r, 'targeting', () =>
          runStep(ctx, () =>
            ctx.exec.targeting(
              r.missionId,
              r.config.targetCount,
              r.config.selectedSectors,
              r.config.selectedFunctions,
              r.config.selectedSeniority
            )
          )
        )
      );
      const targets = seedTargets(found, r.config.topN);
      if (targets.length === 0) {
        finishProcessing(r);
        await ctx.persistStatus(r);
        return r;
      }
      r.targets = targets;
      r.phase = 'processing';
      r.cursor = null;
      r.note = `Researching ${targets.length} ${unitNoun(r)} in parallel…`;
      await ctx.persistStatus(r);
    } catch (e) {
      if (e instanceof PipelineDailyLimitError) {
        recordDailyPause(ctx, e);
        pauseForDaily(r, ctx);
        await ctx.persistStatus(r);
        return r;
      }
      r.status = 'error';
      r.error = e instanceof Error ? e.message : 'pipeline_failed';
      await ctx.persistStatus(r);
      return r;
    }
  } else if (r.status !== 'running') {
    // Resuming a processing run: mark running so the client shows it live.
    r.status = 'running';
    r.note = progressNote(r);
    await ctx.persistStatus(r);
  }

  // --- processing (parallel across targets) ---
  await measureMs(r, 'processingMs', () => runTargetPool(r, ctx, replacements));
  // Backfill any company that came up with no reachable contact so the user
  // still gets the count they asked for, drawn from backups (no empty cards).
  await replenishTargets(r, ctx, replacements);

  if (ctx.canceled) return r; // cancelPipeline already wrote status='canceled'
  if (ctx.paused) {
    pauseForDaily(r, ctx);
    await ctx.persistStatus(r);
    return r;
  }
  finishProcessing(r);
  await ctx.persistStatus(r);
  return r;
}

// ---------------------------------------------------------------------------
// Persistence-backed driver.
// ---------------------------------------------------------------------------
const PIPELINE_RUNS = 'pipeline_runs' as const;

// Only target/note progress - never status, so a worker write can't clobber a
// concurrent cancel.
function progressFields(r: PipelineRunDoc) {
  return { targets: r.targets, note: r.note, metrics: r.metrics, heartbeatAt: new Date() };
}
function statusFields(r: PipelineRunDoc) {
  return {
    status: r.status,
    phase: r.phase,
    targets: r.targets,
    cursor: r.cursor,
    note: r.note,
    error: r.error,
    dailyResetAt: r.dailyResetAt ?? null,
    metrics: r.metrics,
    completedAt: r.completedAt,
    heartbeatAt: new Date(),
  };
}

// Runs currently being driven *in this process* - prevents a start and a
// concurrent resume-poll from double-driving the same run.
const active = new Set<string>();

async function loadRun(scope: UserScope, runId: string): Promise<PipelineRunDoc | null> {
  return (await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).findById(runId)) as PipelineRunDoc | null;
}

/** Per-run target concurrency, derived from the plan's per-minute cap with
 *  headroom and clamped to a small ceiling. */
async function pipelineConcurrency(scope: UserScope): Promise<number> {
  try {
    const limits = await getPlanLimits(scope);
    const fromPlan = Math.floor(((limits.agentRunsPerMinute ?? 0) - 1) / 3); // targeting + roughly 3 agent runs per company
    return Math.max(1, Math.min(MAX_PIPELINE_CONCURRENCY, fromPlan || DEFAULT_PIPELINE_CONCURRENCY));
  } catch {
    return DEFAULT_PIPELINE_CONCURRENCY;
  }
}

async function driveLoop(scope: UserScope, runId: string, exec: PipelineExecutors): Promise<void> {
  const run = await loadRun(scope, runId);
  if (!run || HALTED.has(run.status)) return;

  const runs = scope.collection<PipelineRunDoc>(PIPELINE_RUNS);
  // Serialize Mongo writes so progress and status updates stay FIFO-ordered.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = (fields: Record<string, unknown>) => {
    chain = chain.then(() => runs.updateById(runId, fields as never));
    return chain.then(() => undefined);
  };

  const ctx: ProcContext = {
    exec,
    concurrency: await pipelineConcurrency(scope),
    contactConcurrency: CONTACT_CONCURRENCY,
    launchStaggerMs: LAUNCH_STAGGER_MS,
    paused: false,
    canceled: false,
    persist: (r) => enqueue(progressFields(r)),
    persistStatus: (r) => enqueue(statusFields(r)),
    sleep: (ms) => new Promise<void>((res) => setTimeout(res, ms)),
    checkCanceled: async () => {
      const cur = await loadRun(scope, runId);
      return !cur || cur.status === 'canceled';
    },
  };

  try {
    const end = await runPipeline(run, ctx);
    if (end.metrics) {
      console.info('[pipeline] run metrics', {
        runId,
        status: end.status,
        metrics: end.metrics,
      });
    }
  } catch (e) {
    await enqueue({
      status: 'error',
      error: e instanceof Error ? e.message : 'pipeline_failed',
      heartbeatAt: new Date(),
    });
  }
  await chain; // ensure the final write lands before the driver releases the run
}

/** Start (or resume) driving a run in the background of this process. Idempotent. */
export function ensureDriving(user: AuthedUser, runId: string, exec?: PipelineExecutors): void {
  if (active.has(runId)) return;
  active.add(runId);
  const scope = forUser(user.id);
  const executors = exec ?? realExecutors(user);
  void driveLoop(scope, runId, executors)
    .catch((err) => console.error('[pipeline] driver crashed', runId, err))
    .finally(() => active.delete(runId));
}

/**
 * Await-able resume for the server-side sweeper (api/cron/resume-runs.ts). Drives
 * the run to its next halt WITHIN the caller's request so Cloud Run keeps CPU
 * allocated for the work (a fire-and-forget background promise gets throttled
 * once the response is sent). Idempotent via the in-process `active` guard;
 * every step persists, so if the request is cut short the next sweep resumes
 * from exactly where it stopped. This is what makes a run finish after the
 * user's tab closes - nothing else re-drives a stalled run unattended.
 */
export async function driveStaleRun(user: AuthedUser, runId: string): Promise<boolean> {
  if (active.has(runId)) return false;
  active.add(runId);
  const scope = forUser(user.id);
  try {
    await driveLoop(scope, runId, realExecutors(user));
    return true;
  } catch (err) {
    console.error('[pipeline] resume drive failed', runId, err);
    return false;
  } finally {
    active.delete(runId);
  }
}

export interface StartPipelineArgs {
  user: AuthedUser;
  missionId: string;
  targetCount?: number;
  topN?: number;
  topContacts?: number;
  selectedFunctions?: string[];
  selectedSeniority?: SeniorityLevel[];
  selectedSectors?: string[];
  exec?: PipelineExecutors; // tests inject; prod uses realExecutors
}

const VALID_LEVELS: ReadonlySet<string> = new Set<SeniorityLevel>([
  'ic', 'senior_ic', 'lead', 'manager', 'senior_manager', 'director',
  'senior_director', 'vp', 'svp', 'cxo', 'founder',
]);

function sanitizeStrings(list?: string[]): string[] {
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

function sanitizeLevels(list?: SeniorityLevel[]): SeniorityLevel[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list)].filter((l): l is SeniorityLevel => VALID_LEVELS.has(l));
}

/** Create a run doc and kick off the background driver. Returns the run id. */
export async function startPipeline(args: StartPipelineArgs): Promise<PipelineRunDoc> {
  const scope = forUser(args.user.id);
  const now = new Date();
  // The find mode comes from the mission and shapes the run: people mode pursues
  // exactly one person per target (topN = number of people), and the note copy
  // reflects what's being hunted.
  const mission = await scope.collection<MissionDoc>('missions').findById(args.missionId);
  const findMode: FindMode = mission?.findMode === 'people' ? 'people' : 'companies';
  const topContacts =
    findMode === 'people' ? 1 : Math.min(Math.max(args.topContacts ?? DEFAULT_TOP_CONTACTS, 1), MAX_TOP_CONTACTS);
  const run = await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).insertOne({
    _id: newId(),
    missionId: args.missionId,
    status: 'pending',
    phase: 'targeting',
    config: {
      targetCount: Math.min(Math.max(args.targetCount ?? DEFAULT_TARGET_COUNT, 1), 25),
      topN: Math.min(Math.max(args.topN ?? DEFAULT_TOP_N, 1), 15),
      topContacts,
      findMode,
      selectedFunctions: sanitizeStrings(args.selectedFunctions),
      selectedSeniority: sanitizeLevels(args.selectedSeniority),
      selectedSectors: sanitizeStrings(args.selectedSectors),
    },
    targets: [],
    cursor: null,
    note:
      findMode === 'people'
        ? 'Finding people who match, across any company…'
        : 'Finding high-fit companies with a reason to reach out now…',
    error: null,
    heartbeatAt: now,
    metrics: {},
    startedAt: now,
    completedAt: null,
  } as never);
  ensureDriving(args.user, run._id, args.exec);
  return run as PipelineRunDoc;
}

/**
 * Resume a run that paused on the daily agent-run cap. Flips it back to
 * `pending` (clearing the captured reset time) and drives it. We re-drive
 * rather than just unblock because nothing else ever moves a `paused` run:
 * `runPipeline`/`driveLoop` early-return on any HALTED status, and both
 * `resumeIfStale` and the resume sweeper otherwise only act on pending/running
 * runs - so without this a paused run is orphaned forever.
 *
 * The next agent call re-checks the caller's CURRENT daily limit, so this is
 * correct for both ways a paused run should free up: the rolling 24h window
 * draining, and a plan upgrade raising the cap. If the caller is still over,
 * the run simply re-pauses with a fresh reset time. Idempotent via `active`.
 */
export async function resumePausedRun(user: AuthedUser, runId: string): Promise<boolean> {
  if (active.has(runId)) return false;
  const scope = forUser(user.id);
  const run = await loadRun(scope, runId);
  if (!run || run.status !== 'paused') return false;
  await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).updateById(runId, {
    status: 'pending',
    dailyResetAt: null,
    heartbeatAt: new Date(),
  } as never);
  return driveStaleRun(user, runId);
}

/** If a run claims to be live but its driver has gone silent, re-drive it. */
export function resumeIfStale(user: AuthedUser, run: PipelineRunDoc): void {
  if (run.status !== 'pending' && run.status !== 'running') return;
  const age = Date.now() - new Date(run.heartbeatAt).getTime();
  if (age > STALE_HEARTBEAT_MS) ensureDriving(user, run._id);
}

/** Mark a run canceled; the driver observes this between steps and stops. */
export async function cancelPipeline(user: AuthedUser, runId: string): Promise<boolean> {
  const scope = forUser(user.id);
  const run = await loadRun(scope, runId);
  if (!run) return false;
  if (HALTED.has(run.status)) return true;
  await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).updateById(runId, { status: 'canceled', note: null });
  return true;
}
