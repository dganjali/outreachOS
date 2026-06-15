// Durable, resumable pipeline orchestration - the server-side replacement for
// the old browser-driven run (which executed ~16 agent calls in the tab and
// died on close).
//
// Design:
//   • The `pipeline_runs` doc is the single source of truth for progress.
//   • `advancePipeline()` is a pure-ish reducer: given a run + executors, it
//     performs exactly ONE unit of work and returns the next run state. No I/O
//     to Mongo lives in it, so it is trivially unit-testable with fake executors.
//   • The driver loop persists after every step and writes a heartbeat, so a
//     dropped connection or a restarted instance loses nothing - any later poll
//     re-drives the run from its cursor (`resumeIfStale`).

import { forUser, newId, type UserScope } from './db';
import type { AuthedUser } from './auth';
import { invokeAgent } from './internal-invoke';
import type { PipelineRunDoc, PipelineStepStatus } from '../../shared/schemas';

import targetHandler from '../agents/target';
import evidenceHandler from '../agents/evidence';
import contactsHandler from '../agents/contacts';
import sequenceHandler from '../agents/sequence';

export const DEFAULT_TARGET_COUNT = 8;
export const DEFAULT_TOP_N = 5;
export const DEFAULT_TOP_CONTACTS = 1;
export const MAX_TOP_CONTACTS = 5;

const PACE_MS = 2_500; // gap between steps so a per-minute cap doesn't stall us
const MINUTE_RETRY_WAIT_MS = 35_000;
const MINUTE_RETRY_MAX = 2;
export const STALE_HEARTBEAT_MS = 90_000; // older than this ⇒ driver is dead

// ---------------------------------------------------------------------------
// Typed errors so the reducer can tell "wait a minute" from "stop for today".
// ---------------------------------------------------------------------------
export class PipelineRateLimitError extends Error {} // per-minute: retryable
export class PipelineDailyLimitError extends Error {} // per-day: pause the run

// ---------------------------------------------------------------------------
// Executors - the side-effecting calls the reducer drives. Real ones reuse the
// existing agent handlers verbatim via in-process invocation; tests pass fakes.
// ---------------------------------------------------------------------------
export interface PipelineExecutors {
  targeting(missionId: string, count: number): Promise<Array<{ id: string; name: string; score: number | null }>>;
  evidence(targetId: string): Promise<void>;
  contacts(targetId: string): Promise<Array<{ id: string; confidence: number | null }>>;
  sequence(contactId: string): Promise<void>;
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
    async targeting(missionId, count) {
      const body = classify<{ targets?: Array<{ _id: string; companyName: string; score: number | null }> }>(
        await invokeAgent(targetHandler, { user, body: { mission_id: missionId, count } })
      );
      return (body.targets ?? []).map((t) => ({ id: t._id, name: t.companyName, score: t.score ?? null }));
    },
    async evidence(targetId) {
      classify(await invokeAgent(evidenceHandler, { user, body: { target_id: targetId } }));
    },
    async contacts(targetId) {
      const body = classify<{ contacts?: Array<{ _id: string; confidence: number | null }> }>(
        await invokeAgent(contactsHandler, { user, body: { target_id: targetId } })
      );
      return (body.contacts ?? []).map((c) => ({ id: c._id, confidence: c.confidence ?? null }));
    },
    async sequence(contactId) {
      classify(await invokeAgent(sequenceHandler, { user, body: { contact_id: contactId } }));
    },
  };
}

// ---------------------------------------------------------------------------
// The reducer. One call = one unit of work. Returns the next run state.
// ---------------------------------------------------------------------------
const HALTED: ReadonlySet<PipelineRunDoc['status']> = new Set(['paused', 'done', 'error', 'canceled']);

function step(t: PipelineRunDoc['targets'][number], key: 'evidence' | 'contacts' | 'sequence', s: PipelineStepStatus) {
  t[key] = s;
}

function finishProcessing(r: PipelineRunDoc): PipelineRunDoc {
  r.phase = 'done';
  r.status = 'done';
  r.cursor = null;
  r.note = null;
  r.completedAt = new Date();
  return r;
}

function toNextTarget(r: PipelineRunDoc): void {
  const next = (r.cursor?.targetIndex ?? 0) + 1;
  if (next < r.targets.length) {
    r.cursor = { targetIndex: next, step: 'research' };
    r.note = `Researching ${r.targets[next].name}…`;
  } else {
    finishProcessing(r);
  }
}

const isResolved = (s: PipelineStepStatus) => s === 'done' || s === 'failed';

// Pick the contacts we draft for: top `topContacts` by reply-likelihood. Stored
// on the target as soon as contacts resolves so the selection survives a partial
// 'research' retry (when evidence rate-limits but contacts already succeeded).
function selectContacts(
  t: PipelineRunDoc['targets'][number],
  contacts: Array<{ id: string; confidence: number | null }>,
  topContacts: number,
): void {
  const ranked = [...contacts].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  t.contactIds = ranked.slice(0, Math.max(1, topContacts)).map((c) => c.id);
  t.bestContactId = t.contactIds[0] ?? null;
  t.sequences = t.contactIds.map(() => 'queued');
}

export async function advancePipeline(run: PipelineRunDoc, exec: PipelineExecutors): Promise<PipelineRunDoc> {
  // Work on a copy so callers can diff/compare; the driver persists the result.
  const r: PipelineRunDoc = { ...run, targets: run.targets.map((t) => ({ ...t })), cursor: run.cursor ? { ...run.cursor } : null };
  if (HALTED.has(r.status)) return r;
  r.status = 'running';

  if (r.phase === 'targeting') {
    const found = await exec.targeting(r.missionId, r.config.targetCount);
    const top = [...found].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, r.config.topN);
    if (top.length === 0) return finishProcessing(r);
    r.targets = top.map((t) => ({
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
    r.phase = 'processing';
    r.cursor = { targetIndex: 0, step: 'research' };
    r.note = `Researching ${top[0].name}…`;
    return r;
  }

  // phase === 'processing'
  if (!r.cursor || r.cursor.targetIndex >= r.targets.length) return finishProcessing(r);
  const t = r.targets[r.cursor.targetIndex];

  // 'research': run evidence + contacts CONCURRENTLY (contacts never reads the
  // evidence pack; only 'sequence' needs both). Each sub-step is gated on its own
  // persisted per-target status, so a retry never re-runs a completed sub-step -
  // the key to staying idempotent when one sub-step rate-limits after the other
  // already succeeded and persisted.
  if (r.cursor.step !== 'sequence') {
    r.cursor = { ...r.cursor, step: 'research' }; // normalize legacy 'evidence'/'contacts'
    const jobs: Array<'evidence' | 'contacts'> = [];
    if (!isResolved(t.evidence)) jobs.push('evidence');
    if (!isResolved(t.contacts)) jobs.push('contacts');

    const settled = await Promise.allSettled(
      jobs.map((j) => (j === 'evidence' ? exec.evidence(t.targetId) : exec.contacts(t.targetId)))
    );

    let rateLimited = false;
    let dailyLimited = false;
    let resolvedThisPass = false; // a sub-step reached a terminal state this pass
    settled.forEach((res, idx) => {
      const job = jobs[idx];
      if (res.status === 'fulfilled') {
        resolvedThisPass = true;
        if (job === 'evidence') {
          step(t, 'evidence', 'done');
        } else {
          step(t, 'contacts', 'done');
          selectContacts(t, (res.value ?? []) as Array<{ id: string; confidence: number | null }>, r.config.topContacts);
        }
      } else {
        const e = res.reason;
        if (e instanceof PipelineRateLimitError) rateLimited = true;
        else if (e instanceof PipelineDailyLimitError) dailyLimited = true;
        else {
          step(t, job, 'failed');
          resolvedThisPass = true;
        }
      }
    });

    // Still incomplete ⇒ a limit error left a sub-step queued.
    if (!isResolved(t.evidence) || !isResolved(t.contacts)) {
      // Nothing advanced this pass: hand control back to the driver so it backs
      // off (per-minute) or pauses (per-day) instead of busy-spinning.
      if (!resolvedThisPass) {
        if (rateLimited) throw new PipelineRateLimitError('rate_limited');
        if (dailyLimited) return pauseForDaily(r);
      }
      // Partial success this pass: persist it and stay on 'research'. The next
      // advance re-runs ONLY the unfinished sub-step (the done one is skipped).
      if (dailyLimited) return pauseForDaily(r);
      return r;
    }

    // Both resolved. Evidence is the precondition for drafting (sequence requires
    // an evidence pack), so a failed evidence fails the whole target.
    if (t.evidence === 'failed') {
      step(t, 'contacts', 'failed');
      step(t, 'sequence', 'failed');
      toNextTarget(r);
      return r;
    }
    if (t.contacts === 'failed' || t.contactIds.length === 0) {
      step(t, 'sequence', 'failed');
      toNextTarget(r);
      return r;
    }
    r.cursor = { targetIndex: r.cursor.targetIndex, step: 'sequence', contactIndex: 0 };
    r.note = draftNote(t, 0);
    return r;
  }

  // r.cursor.step === 'sequence' - draft one contact per advance so a rate limit
  // or daily cap pauses cleanly between drafts and resumes at this contactIndex.
  const ci = r.cursor.contactIndex ?? 0;
  const contactId = t.contactIds[ci];
  try {
    if (!contactId) throw new Error('no_contact');
    await exec.sequence(contactId);
    t.sequences[ci] = 'done';
  } catch (e) {
    if (e instanceof PipelineRateLimitError) throw e;
    if (e instanceof PipelineDailyLimitError) return pauseForDaily(r);
    t.sequences[ci] = 'failed';
  }
  const nextCi = ci + 1;
  if (nextCi < t.contactIds.length) {
    r.cursor = { ...r.cursor, step: 'sequence', contactIndex: nextCi };
    r.note = draftNote(t, nextCi);
    return r;
  }
  // All contacts attempted - the target's draft step is done if any succeeded.
  step(t, 'sequence', t.sequences.some((s) => s === 'done') ? 'done' : 'failed');
  toNextTarget(r);
  return r;
}

// Note shown while drafting; names the contact position when pursuing several.
function draftNote(t: PipelineRunDoc['targets'][number], contactIndex: number): string {
  const total = t.contactIds.length;
  return total > 1
    ? `Drafting personalized emails for ${t.name} (${contactIndex + 1} of ${total})…`
    : `Drafting a personalized email for ${t.name}…`;
}

function pauseForDaily(r: PipelineRunDoc): PipelineRunDoc {
  r.status = 'paused';
  r.note = "Daily agent-run limit reached - finished targets are ready; the rest resume tomorrow.";
  return r; // cursor preserved so a later run resumes exactly here
}

// ---------------------------------------------------------------------------
// Persistence-backed driver.
// ---------------------------------------------------------------------------
function persistableFields(r: PipelineRunDoc) {
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

const PIPELINE_RUNS = 'pipeline_runs' as const;

// Runs currently being driven *in this process* - prevents a start and a
// concurrent resume-poll from double-driving the same run.
const active = new Set<string>();

async function loadRun(scope: UserScope, runId: string): Promise<PipelineRunDoc | null> {
  return (await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).findById(runId)) as PipelineRunDoc | null;
}

async function driveLoop(scope: UserScope, runId: string, exec: PipelineExecutors): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  for (;;) {
    const run = await loadRun(scope, runId);
    if (!run || HALTED.has(run.status)) return;

    let next: PipelineRunDoc;
    try {
      next = await advancePipeline(run, exec);
    } catch (e) {
      if (e instanceof PipelineRateLimitError) {
        // Per-minute throttle - pace and retry the same cursor a few times.
        const tries = ((run as PipelineRunDoc & { _minuteRetries?: number })._minuteRetries ?? 0) + 1;
        await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).updateById(runId, {
          note: 'Pacing requests, resuming shortly…',
          heartbeatAt: new Date(),
        });
        if (tries > MINUTE_RETRY_MAX) {
          await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).updateById(runId, {
            status: 'error',
            error: 'rate_limited',
            heartbeatAt: new Date(),
          });
          return;
        }
        await sleep(MINUTE_RETRY_WAIT_MS);
        continue;
      }
      await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).updateById(runId, {
        status: 'error',
        error: e instanceof Error ? e.message : 'pipeline_failed',
        heartbeatAt: new Date(),
      });
      return;
    }

    await scope.collection<PipelineRunDoc>(PIPELINE_RUNS).updateById(runId, persistableFields(next));
    if (HALTED.has(next.status)) return;
    await sleep(PACE_MS);
  }
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
  exec?: PipelineExecutors; // tests inject; prod uses realExecutors
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
