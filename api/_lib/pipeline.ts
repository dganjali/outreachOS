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
import type { PipelineRunDoc, PipelineStepStatus, PipelineTargetState, TargetDoc } from '../../shared/schemas';
import type { ContactTypeFilter, SeniorityLevel } from '../../shared/types';

import targetHandler from '../agents/target';
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
export const DEFAULT_PIPELINE_CONCURRENCY = 3;
export const MAX_PIPELINE_CONCURRENCY = 4;
// Drafts overlapped within a single target (topContacts is small).
const CONTACT_CONCURRENCY = 2;
// Ceiling on how many backup companies a single run will pull in to replace
// ones that yield no reachable contact. Bounds re-discovery cost and guarantees
// the replenish loop terminates even if every backup also comes up empty.
const MAX_REPLACEMENTS = 12;
// Beat between starting successive target workers, to desynchronize the
// count-then-insert in runs.ts:checkRateLimit (bounds daily-cap overshoot).
const LAUNCH_STAGGER_MS = 600;

const MINUTE_RETRY_WAIT_MS = 35_000;
const MINUTE_RETRY_MAX = 2;
export const STALE_HEARTBEAT_MS = 90_000; // older than this ⇒ driver is dead

// ---------------------------------------------------------------------------
// Typed errors so a step can tell "wait a minute" from "stop for today".
// ---------------------------------------------------------------------------
export class PipelineRateLimitError extends Error {} // per-minute: retryable
export class PipelineDailyLimitError extends Error {} // per-day: pause the run

// ---------------------------------------------------------------------------
// Executors - the side-effecting calls the driver runs. Real ones reuse the
// existing agent handlers verbatim via in-process invocation; tests pass fakes.
// ---------------------------------------------------------------------------
export interface PipelineExecutors {
  targeting(missionId: string, count: number, sectors?: string[]): Promise<Array<{ id: string; name: string; score: number | null }>>;
  evidence(targetId: string): Promise<void>;
  contacts(targetId: string, filter?: ContactTypeFilter, topContacts?: number): Promise<Array<{ id: string; confidence: number | null }>>;
  sequence(contactId: string): Promise<void>;
  /** Already-discovered companies not yet in the run, ranked by score - the
   *  over-discovery "reserve" we pull from when a company yields no contact.
   *  `excludeIds` are targets already in the run. */
  reserve(missionId: string, excludeIds: string[]): Promise<Array<{ id: string; name: string; score: number | null }>>;
  /** Drop a company from the user-facing output (no deliverable contact found). */
  markRejected(targetId: string): Promise<void>;
}

function classify<T = Record<string, unknown>>(result: { status: number; body: unknown }): T {
  const body = (result.body ?? {}) as Record<string, unknown>;
  if (result.status === 429) {
    const detail = String(body.detail ?? body.error ?? '');
    if (/daily/i.test(detail)) throw new PipelineDailyLimitError(detail || 'daily_limit');
    throw new PipelineRateLimitError(detail || 'rate_limit');
  }
  if (result.status >= 400) {
    throw new Error(String(body.detail ?? body.error ?? `status_${result.status}`));
  }
  return body as T;
}

export function realExecutors(user: AuthedUser): PipelineExecutors {
  return {
    async targeting(missionId, count, sectors) {
      const body = classify<{ targets?: Array<{ _id: string; companyName: string; score: number | null }> }>(
        await invokeAgent(targetHandler, { user, body: { mission_id: missionId, count, sectors } })
      );
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
      classify(await invokeAgent(sequenceHandler, { user, body: { contact_id: contactId } }));
    },
    async reserve(missionId, excludeIds) {
      const scope = forUser(user.id);
      const exclude = new Set(excludeIds);
      // The targeting agent over-discovers and inserts the whole pool as
      // 'suggested'; the ones we never seeded are our backup bench.
      const all = await scope.collection<TargetDoc>('targets').find({ missionId, status: 'suggested' });
      return all
        .filter((t) => !exclude.has(t._id))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map((t) => ({ id: t._id, name: t.companyName, score: t.score ?? null }));
    },
    async markRejected(targetId) {
      const scope = forUser(user.id);
      await scope.collection<TargetDoc>('targets').updateById(targetId, { status: 'rejected' } as Partial<TargetDoc>);
    },
  };
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
  r.completedAt = new Date();
  return r;
}

function pauseForDaily(r: PipelineRunDoc): PipelineRunDoc {
  r.status = 'paused';
  r.cursor = null;
  r.note = 'Daily agent-run limit reached - finished targets are ready; the rest resume tomorrow.';
  return r; // per-target statuses preserved so a later run resumes exactly here
}

/** A target is finished once its aggregate draft status is terminal; every
 *  failure path cascades to sequence='failed', so this single field decides it. */
function targetTerminal(t: PipelineTargetState): boolean {
  return t.sequence === 'done' || t.sequence === 'failed';
}

function progressNote(r: PipelineRunDoc): string {
  const total = r.targets.length;
  const done = r.targets.filter(targetTerminal).length;
  return `Researched ${done} of ${total} companies…`;
}

function cloneRun(run: PipelineRunDoc): PipelineRunDoc {
  return {
    ...run,
    targets: run.targets.map((t) => ({ ...t, contactIds: [...t.contactIds], sequences: [...t.sequences] })),
    cursor: null,
  };
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
async function runEvidence(t: PipelineTargetState, ctx: ProcContext): Promise<void> {
  try {
    await runStep(ctx, () => ctx.exec.evidence(t.targetId));
    step(t, 'evidence', 'done');
  } catch (e) {
    if (e instanceof PipelineDailyLimitError) {
      ctx.paused = true;
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
    const contacts = await runStep(ctx, () => ctx.exec.contacts(t.targetId, filter, r.config.topContacts));
    step(t, 'contacts', 'done');
    selectContacts(t, contacts, r.config.topContacts);
  } catch (e) {
    if (e instanceof PipelineDailyLimitError) {
      ctx.paused = true;
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
async function processTarget(r: PipelineRunDoc, t: PipelineTargetState, ctx: ProcContext): Promise<void> {
  // --- research: evidence + contacts run concurrently (independent work) ---
  if (!isResolved(t.evidence) || !isResolved(t.contacts)) {
    if (halted(ctx)) return;
    if (!isResolved(t.evidence)) step(t, 'evidence', 'running');
    if (!isResolved(t.contacts)) step(t, 'contacts', 'running');
    await ctx.persist(r);

    const subs: Array<Promise<void>> = [];
    if (!isResolved(t.evidence)) subs.push(runEvidence(t, ctx));
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
      return;
    }
    if (t.contacts === 'failed' || t.contactIds.length === 0) {
      step(t, 'sequence', 'failed');
      await dropTarget(t, ctx);
      r.note = progressNote(r);
      await ctx.persist(r);
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
        await runStep(ctx, () => ctx.exec.sequence(t.contactIds[i]));
        t.sequences[i] = 'done';
      } catch (e) {
        if (e instanceof PipelineDailyLimitError) {
          ctx.paused = true;
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
    step(t, 'sequence', t.sequences.some((s) => s === 'done') ? 'done' : 'failed');
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

/** Pull non-terminal targets through `processTarget` with bounded concurrency,
 *  starting workers a beat apart and stopping early on pause/cancel. */
async function runTargetPool(r: PipelineRunDoc, ctx: ProcContext): Promise<void> {
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
      await processTarget(r, queue[i], ctx);
    }
  };
  await Promise.all(Array.from({ length: n }, (_, w) => worker(w)));
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

/** Companies that actually yielded a reachable contact - the real deliverables
 *  the replenish loop counts toward the requested topN. */
function deliveredCount(r: PipelineRunDoc): number {
  return r.targets.filter((t) => t.contacts === 'done' && t.contactIds.length > 0).length;
}

/** Backfill companies that yielded no contact: pull the next-best from the
 *  already-discovered reserve, then (once it's exhausted) re-discover a fresh
 *  batch, processing each new company until we have `topN` companies with
 *  contacts or hit MAX_REPLACEMENTS. Honors pause/cancel like the main pool. */
async function replenishTargets(r: PipelineRunDoc, ctx: ProcContext): Promise<void> {
  let added = 0;
  while (!halted(ctx) && deliveredCount(r) < r.config.topN && added < MAX_REPLACEMENTS) {
    if (await observeCancel(ctx)) return;
    const need = r.config.topN - deliveredCount(r);
    const have = new Set(r.targets.map((t) => t.targetId));

    let candidates: Array<{ id: string; name: string; score: number | null }> = [];
    try {
      candidates = await ctx.exec.reserve(r.missionId, [...have]);
    } catch (err) {
      console.warn('reserve_lookup_failed', r.missionId, err);
    }

    if (candidates.length === 0) {
      // Reserve exhausted → discover a fresh batch (the agent already excludes
      // companies already targeted in this mission), then keep going.
      try {
        const found = await runStep(ctx, () => ctx.exec.targeting(r.missionId, r.config.targetCount, r.config.selectedSectors));
        candidates = found.filter((f) => !have.has(f.id));
      } catch (e) {
        if (e instanceof PipelineDailyLimitError) {
          ctx.paused = true;
          return;
        }
        return; // re-discovery failed → nothing more we can do this run
      }
    }
    if (candidates.length === 0) return; // genuinely nothing left to try

    const room = MAX_REPLACEMENTS - added;
    const picks = [...candidates]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, Math.min(need, room));
    const fresh = seedTargets(picks, picks.length);
    r.targets.push(...fresh);
    added += fresh.length;
    r.note = 'Finding replacements for companies with no reachable contact…';
    await ctx.persist(r);

    await runTargetPool(r, ctx); // process the newly queued backups
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

  // --- targeting ---
  if (r.phase === 'targeting') {
    r.status = 'running';
    try {
      const found = await runStep(ctx, () => ctx.exec.targeting(r.missionId, r.config.targetCount, r.config.selectedSectors));
      const targets = seedTargets(found, r.config.topN);
      if (targets.length === 0) {
        finishProcessing(r);
        await ctx.persistStatus(r);
        return r;
      }
      r.targets = targets;
      r.phase = 'processing';
      r.cursor = null;
      r.note = `Researching ${targets.length} companies in parallel…`;
      await ctx.persistStatus(r);
    } catch (e) {
      if (e instanceof PipelineDailyLimitError) {
        pauseForDaily(r);
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
  await runTargetPool(r, ctx);
  // Backfill any company that came up with no reachable contact so the user
  // still gets the count they asked for, drawn from backups (no empty cards).
  await replenishTargets(r, ctx);

  if (ctx.canceled) return r; // cancelPipeline already wrote status='canceled'
  if (ctx.paused) {
    pauseForDaily(r);
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
  return { targets: r.targets, note: r.note, heartbeatAt: new Date() };
}
function statusFields(r: PipelineRunDoc) {
  return {
    status: r.status,
    phase: r.phase,
    targets: r.targets,
    cursor: r.cursor,
    note: r.note,
    error: r.error,
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
    const fromPlan = Math.floor((limits.agentRunsPerMinute ?? 0) / 4); // leave burst headroom
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
    await runPipeline(run, ctx);
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
  const run = await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).insertOne({
    _id: newId(),
    missionId: args.missionId,
    status: 'pending',
    phase: 'targeting',
    config: {
      targetCount: Math.min(Math.max(args.targetCount ?? DEFAULT_TARGET_COUNT, 1), 25),
      topN: Math.min(Math.max(args.topN ?? DEFAULT_TOP_N, 1), 15),
      topContacts: Math.min(Math.max(args.topContacts ?? DEFAULT_TOP_CONTACTS, 1), MAX_TOP_CONTACTS),
      selectedFunctions: sanitizeStrings(args.selectedFunctions),
      selectedSeniority: sanitizeLevels(args.selectedSeniority),
      selectedSectors: sanitizeStrings(args.selectedSectors),
    },
    targets: [],
    cursor: null,
    note: 'Finding high-fit companies with a reason to reach out now…',
    error: null,
    heartbeatAt: now,
    startedAt: now,
    completedAt: null,
  } as never);
  ensureDriving(args.user, run._id, args.exec);
  return run as PipelineRunDoc;
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
