// Shared context assembly for the personalization engine.
//
// Both the single-draft handler (api/agents/draft.ts) and the sequence agent
// (api/agents/sequence.ts, the live pipeline path) need the same thing: turn a
// contact→target→mission→persona into a fully-formed `AssembledContext` the pure
// engine can run on. This module owns that DB/retrieval work so neither caller
// duplicates it and the engine stays free of DB/HTTP.

import { adminDb, forUser } from './db';
import { embedOne } from './embeddings';
import type { AssembledContext, AllowedFact } from './engine';
import { emptyStyleProfile } from '../../shared/schemas';
import type {
  ContactDoc,
  ContextFactDoc,
  EvidencePackDoc,
  MissionDoc,
  PersonaDoc,
  ProfileDoc,
  StyleExemplarDoc,
  TargetDoc,
} from '../../shared/schemas';

// Caps keep the prompt bounded + cost predictable regardless of context-bank size.
const MAX_FACTS = 12;
const MAX_EXEMPLARS = 3;
// A pack can hold up to 8 bullets; feeding all of them dilutes the draft and
// invites generic picks. Keep only the strongest few so the writer leads on the
// best signal rather than the first one.
const MAX_EVIDENCE = 5;

// Signal types worth leading an email on, ranked. Recent funding/launches/hiring
// are far stronger outreach hooks than a stray blog post.
const SIGNAL_WEIGHT: Record<string, number> = {
  funding: 5,
  launch: 5,
  partnership: 4,
  hiring: 4,
  hire: 4,
  leadership: 4,
  press: 3,
  sponsorship: 3,
  talk: 2,
  blog: 2,
  other: 1,
};

function signalScore(signalType: string | null | undefined): number {
  return SIGNAL_WEIGHT[(signalType ?? '').toLowerCase().trim()] ?? 1;
}

// Map a freeform recency string ("2 weeks ago", "Q3 2025", "last month") to a
// freshness score. Relative terms dominate real packs, so key off those rather
// than parsing absolute dates (which drift as "now" moves).
function recencyScore(recency: string | null | undefined): number {
  const s = (recency ?? '').toLowerCase();
  if (!s) return 1.5;
  if (/\b(today|yesterday|day|days|this week|last week|week|weeks|recent|just)\b/.test(s)) return 4;
  if (/\b(month|months|last month|q[1-4]|quarter)\b/.test(s)) return 2.5;
  return 1.5;
}

// Small nudge: does the bullet touch the recipient's own role/headline terms?
function roleRelevanceScore(
  fact: string,
  recipient: { role?: string | null; headline?: string | null } | undefined
): number {
  if (!recipient) return 0;
  const tokens = `${recipient.role ?? ''} ${recipient.headline ?? ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  if (tokens.length === 0) return 0;
  const hay = fact.toLowerCase();
  const hits = new Set(tokens.filter((t) => hay.includes(t)));
  return Math.min(hits.size, 3); // capped so relevance never dominates signal/recency
}

type EvidenceBullet = EvidencePackDoc['bullets'][number];

/**
 * Score + cap a pack's bullets to the strongest few. Each kept bullet retains
 * its ORIGINAL index so the stable citation id (`evidence:<packId>:<index>`)
 * still resolves in the grounding contract.
 */
function rankEvidenceBullets(
  bullets: EvidenceBullet[],
  recipient: { role?: string | null; headline?: string | null } | undefined
): Array<{ bullet: EvidenceBullet; index: number }> {
  return bullets
    .map((bullet, index) => ({
      bullet,
      index,
      score: signalScore(bullet.signalType) + recencyScore(bullet.recency) + roleRelevanceScore(bullet.fact, recipient),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_EVIDENCE);
}

/**
 * The retrieval query that ranks the sender's context facts + voice exemplars.
 * Keyed on the recipient (role + headline) on top of the mission goal so two
 * different people in one mission pull DIFFERENT proof + voice anchors - the
 * single biggest lever against every draft reading the same. When the recipient
 * has no role/headline it degrades to just the goal, so the shared per-mission
 * retrieval cache still applies.
 */
export function buildRetrievalQuery(args: {
  missionGoal: string;
  role?: string | null;
  headline?: string | null;
}): string {
  const recip = [args.role?.trim(), args.headline?.trim()].filter(Boolean).join(', ');
  return recip ? `${args.missionGoal}. Recipient: ${recip}.` : args.missionGoal;
}

type Scope = ReturnType<typeof forUser>;
const CACHE_MARKER = Symbol('DraftContextCache');

export interface AssembledBundle {
  ctx: AssembledContext;
  /** Lineage for telemetry / learning loop attribution. */
  factIds: string[];
  exemplarIds: string[];
  personaVersion: number | null;
}

export interface DraftContextCache {
  readonly [CACHE_MARKER]: true;
  personas: Map<string, Promise<PersonaDoc | null>>;
  profile: Promise<ProfileDoc | null> | null;
  contextFacts: Map<string, Promise<AllowedFact[]>>;
  exemplars: Map<string, Promise<Array<{ id: string; subject: string | null; body: string }>>>;
  queryVectors: Map<string, Promise<number[]>>;
}

export function createDraftContextCache(): DraftContextCache {
  return {
    [CACHE_MARKER]: true,
    personas: new Map(),
    profile: null,
    contextFacts: new Map(),
    exemplars: new Map(),
    queryVectors: new Map(),
  };
}

export function isDraftContextCache(value: unknown): value is DraftContextCache {
  return !!value && typeof value === 'object' && (value as Partial<DraftContextCache>)[CACHE_MARKER] === true;
}

/** Prefer the mission's persona; fall back to the user's default (oldest, non-archived). */
export async function resolvePersona(
  scope: Scope,
  personaId: string | null,
  cache?: DraftContextCache
): Promise<PersonaDoc | null> {
  if (cache) {
    const key = personaId ?? '__default__';
    let p = cache.personas.get(key);
    if (!p) {
      p = resolvePersona(scope, personaId);
      cache.personas.set(key, p);
    }
    return p;
  }
  if (personaId) {
    const p = await scope.collection<PersonaDoc>('personas').findById(personaId);
    if (p && !p.archivedAt) return p;
  }
  const all = await scope.collection<PersonaDoc>('personas').find({ archivedAt: null });
  all.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  return all[0] ?? null;
}

/** Build the full engine context for one contact. */
export async function assembleDraftContext(
  scope: Scope,
  uid: string,
  args: { contact: ContactDoc; target: TargetDoc; mission: MissionDoc; persona: PersonaDoc | null },
  cache?: DraftContextCache
): Promise<AssembledBundle> {
  const { contact, target, mission, persona } = args;

  // Rank facts + exemplars against THIS recipient, not just the mission, so
  // drafts diverge per person and pull role-relevant proof + voice.
  const retrievalQuery = buildRetrievalQuery({
    missionGoal: mission.goal,
    role: contact.role,
    headline: contact.headline,
  });
  const facts = await assembleAllowedFacts(scope, uid, mission._id, target._id, retrievalQuery, {
    excludedFactIds: persona?.excludedFactIds ?? [],
    // Facts the user pinned on this mission - always featured, cap-exempt.
    emphasizedFactIds: mission.emphasizedFactIds ?? [],
    recipient: { role: contact.role, headline: contact.headline },
    // Individualized research from the verification gate - facts about THIS
    // person, so the draft can reference the human, not just their employer.
    personResearch: contact.personResearch ?? null,
    contactId: contact._id,
  }, cache);
  const exemplarDocs = persona ? await fetchExemplars(scope, uid, persona._id, retrievalQuery, cache) : [];
  // Sender identity - anchors a real sign-off on every email (engine.ts).
  const profile = await fetchProfile(scope, cache);

  const ctx: AssembledContext = {
    mode: mission.mode ?? 'sales',
    recipient: {
      name: contact.name,
      role: contact.role,
      company: target.companyName,
      // Their LinkedIn self-description + where they sit - lets the writer tailor
      // relevance/tone instead of personalizing on name+role+company alone.
      headline: contact.headline ?? null,
      location: contact.location ?? null,
    },
    sender: {
      name: profile?.name ?? null,
      role: profile?.role ?? null,
      organization: profile?.organization ?? null,
      headline: senderHeadline(profile),
    },
    missionGoal: mission.goal,
    audience: mission.targetDescription,
    whyNow: target.whyNow ?? undefined,
    directive: mission.draftDirective ?? null,
    allowedFacts: facts,
    exemplars: exemplarDocs.map((e) => ({ subject: e.subject, body: e.body })),
    styleProfile: persona?.styleProfile ?? emptyStyleProfile(),
  };

  return {
    ctx,
    factIds: facts.map((f) => f.id),
    exemplarIds: exemplarDocs.map((e) => e.id),
    personaVersion: persona?.styleProfileVersion ?? null,
  };
}

/**
 * `allowedFacts` = the context bank for this draft (person-level memory bank +
 * this mission's substance, relevance-ranked) + the target's latest evidence
 * bullets. Evidence ids are stable strings (`evidence:<packId>:<index>`) so
 * claims can cite them. Vector search narrows a large bank; on any failure it
 * falls back to recency so grounding still exists.
 */
export async function assembleAllowedFacts(
  scope: Scope,
  uid: string,
  missionId: string | null,
  targetId: string,
  query: string,
  opts: {
    excludedFactIds?: string[];
    emphasizedFactIds?: string[];
    recipient?: { role?: string | null; headline?: string | null };
    personResearch?: ContactDoc['personResearch'];
    contactId?: string;
  } = {},
  cache?: DraftContextCache
): Promise<AllowedFact[]> {
  const facts: AllowedFact[] = [];
  // Memory-bank (person-level) facts this voice opted out of - drop them from
  // grounding so a cleared default never resurfaces in a generated email.
  const excluded = new Set(opts.excludedFactIds ?? []);
  const emphasized = new Set(opts.emphasizedFactIds ?? []);

  const contextFacts = await fetchContextAllowedFacts(scope, uid, missionId, query, excluded, emphasized, cache);
  for (const f of contextFacts) {
    facts.push(f);
  }

  // Recipient-specific research from the verification gate. Tagged source
  // 'evidence' so the engine groups it with the recipient's signals (what to
  // LEAD on), not the sender's proof. A stable id keeps it citable/groundable.
  for (const [i, r] of (opts.personResearch ?? []).entries()) {
    if (!r?.fact?.trim()) continue;
    facts.push({
      id: `person:${opts.contactId ?? targetId}:${i}`,
      claim: r.fact,
      source: 'evidence',
      signal: 'recipient',
    });
  }

  const packs = await scope.collection<EvidencePackDoc>('evidence_packs').find({ targetId });
  packs.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  const latestPack = packs[0];
  if (latestPack) {
    // Score + cap to the strongest signals (recency × signal type × role fit)
    // instead of dumping every bullet, and carry signal/recency through so the
    // writer can lead on the best one.
    for (const { bullet, index } of rankEvidenceBullets(latestPack.bullets, opts.recipient)) {
      facts.push({
        id: `evidence:${latestPack._id}:${index}`,
        claim: bullet.fact,
        source: 'evidence',
        signal: bullet.signalType ?? undefined,
        recency: bullet.recency ?? undefined,
      });
    }
  }

  return facts;
}

async function fetchProfile(scope: Scope, cache?: DraftContextCache): Promise<ProfileDoc | null> {
  if (!cache) return scope.collection<ProfileDoc>('profiles').findOne();
  if (!cache.profile) cache.profile = scope.collection<ProfileDoc>('profiles').findOne();
  return cache.profile;
}

/**
 * The sender's LinkedIn headline (one-line positioning), set by the enrich-profile
 * agent into `profile.linkedinData.headline`. `linkedinData` is loosely typed
 * (Record<string, unknown>), so read it defensively. Returns null when absent.
 */
function senderHeadline(profile: ProfileDoc | null): string | null {
  const raw = (profile?.linkedinData as { headline?: unknown } | null | undefined)?.headline;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

async function fetchContextAllowedFacts(
  scope: Scope,
  uid: string,
  missionId: string | null,
  missionGoal: string,
  excluded: Set<string>,
  emphasized: Set<string>,
  cache?: DraftContextCache
): Promise<AllowedFact[]> {
  const key = `${uid}|${missionId ?? ''}|${missionGoal}|${[...excluded].sort().join(',')}|${[...emphasized].sort().join(',')}`;
  if (cache) {
    let p = cache.contextFacts.get(key);
    if (!p) {
      p = loadContextAllowedFacts(scope, uid, missionId, missionGoal, excluded, emphasized, cache);
      cache.contextFacts.set(key, p);
    }
    return p;
  }
  return loadContextAllowedFacts(scope, uid, missionId, missionGoal, excluded, emphasized);
}

/**
 * Build the sender's context-bank facts for one draft.
 *
 * Vector search RANKS relevance but must never FILTER: a fact without an
 * embedding (best-effort embedding can silently fail on insert) used to vanish
 * the moment any other fact had one, which is why a whole bank collapsed to the
 * same 1-2 facts on every email. So we always load the full candidate set and
 * use the ranked ids only to order it; un-ranked facts fall in behind by recency.
 *
 * Pinned facts (`emphasized`) are always included and cap-exempt, and carry
 * `emphasized: true` so the engine can tell the writer to feature them.
 */
async function loadContextAllowedFacts(
  scope: Scope,
  uid: string,
  missionId: string | null,
  missionGoal: string,
  excluded: Set<string>,
  emphasized: Set<string>,
  cache?: DraftContextCache
): Promise<AllowedFact[]> {
  const candidates = (
    await scope.collection<ContextFactDoc>('context_facts').find(
      missionId
        ? ({ $or: [{ scope: 'person' }, { scope: 'mission', missionId }] } as Record<string, unknown>)
        : { scope: 'person' }
    )
  ).filter((f) => !excluded.has(f._id));

  // Relevance order from vector search (null when unavailable). Only used to sort.
  const ranked = await fetchRankedContextFacts(uid, missionId, missionGoal, cache);
  const rankOf = new Map<string, number>();
  ranked?.forEach((r, i) => rankOf.set(r._id, i));

  const recency = (f: ContextFactDoc) => f.createdAt?.getTime() ?? 0;
  // Ranked facts first (in relevance order); everything else by recency behind them.
  const ordered = [...candidates].sort((a, b) => {
    const ra = rankOf.has(a._id) ? rankOf.get(a._id)! : Infinity;
    const rb = rankOf.has(b._id) ? rankOf.get(b._id)! : Infinity;
    if (ra !== rb) return ra - rb;
    return recency(b) - recency(a);
  });

  const pinned = ordered.filter((f) => emphasized.has(f._id));
  const rest = ordered.filter((f) => !emphasized.has(f._id)).slice(0, MAX_FACTS);

  return [...pinned, ...rest].map((f) => ({
    id: f._id,
    claim: f.claim,
    source: 'context_fact',
    ...(emphasized.has(f._id) ? { emphasized: true } : {}),
  }));
}

async function queryVectorForMissionGoal(missionGoal: string, cache?: DraftContextCache): Promise<number[]> {
  if (!cache) return embedOne(missionGoal, 'query');
  let p = cache.queryVectors.get(missionGoal);
  if (!p) {
    p = embedOne(missionGoal, 'query').catch((err) => {
      cache.queryVectors.delete(missionGoal);
      throw err;
    });
    cache.queryVectors.set(missionGoal, p);
  }
  return p;
}

/** Relevance-rank the context bank via Atlas Vector Search. null ⇒ unavailable. */
async function fetchRankedContextFacts(
  uid: string,
  missionId: string | null,
  missionGoal: string,
  cache?: DraftContextCache
): Promise<Array<{ _id: string; claim: string }> | null> {
  try {
    const queryVector = await queryVectorForMissionGoal(missionGoal, cache);
    const db = await adminDb();
    const search = (filter: Record<string, unknown>) =>
      db
        .collection('context_facts')
        .aggregate([
          {
            $vectorSearch: {
              index: 'context_fact_vector_idx',
              path: 'embedding',
              queryVector,
              numCandidates: 100,
              limit: MAX_FACTS,
              filter,
            },
          },
          { $project: { claim: 1, score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();

    const runs = [search({ userId: uid, scope: 'person' })];
    if (missionId) runs.push(search({ userId: uid, scope: 'mission', missionId }));
    const results = (await Promise.all(runs)).flat();
    if (results.length === 0) return null;
    results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return results.slice(0, MAX_FACTS).map((d) => ({ _id: String(d._id), claim: String(d.claim) }));
  } catch {
    return null;
  }
}

/** Retrieve the persona's most relevant gold exemplars (with ids). [] if none. */
export async function fetchExemplars(
  scope: Scope,
  uid: string,
  personaId: string,
  missionGoal: string,
  cache?: DraftContextCache
): Promise<Array<{ id: string; subject: string | null; body: string }>> {
  const key = `${uid}|${personaId}|${missionGoal}`;
  if (cache) {
    let p = cache.exemplars.get(key);
    if (!p) {
      p = loadExemplars(scope, uid, personaId, missionGoal, cache);
      cache.exemplars.set(key, p);
    }
    return p;
  }
  return loadExemplars(scope, uid, personaId, missionGoal);
}

async function loadExemplars(
  scope: Scope,
  uid: string,
  personaId: string,
  missionGoal: string,
  cache?: DraftContextCache
): Promise<Array<{ id: string; subject: string | null; body: string }>> {
  try {
    const queryVector = await queryVectorForMissionGoal(missionGoal, cache);
    const db = await adminDb();
    const docs = await db
      .collection('style_exemplars')
      .aggregate([
        {
          $vectorSearch: {
            index: 'style_exemplar_vector_idx',
            path: 'embedding',
            queryVector,
            numCandidates: 50,
            limit: MAX_EXEMPLARS,
            filter: { userId: uid, personaId },
          },
        },
        { $project: { subject: 1, body: 1 } },
      ])
      .toArray();
    if (docs.length > 0)
      return docs.map((d) => ({ id: String(d._id), subject: d.subject ?? null, body: String(d.body) }));
  } catch {
    // fall through to recency
  }
  const recent = await scope.collection<StyleExemplarDoc>('style_exemplars').find({ personaId });
  recent.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return recent.slice(0, MAX_EXEMPLARS).map((e) => ({ id: e._id, subject: e.subject, body: e.body }));
}
