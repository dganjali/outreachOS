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

type Scope = ReturnType<typeof forUser>;

export interface AssembledBundle {
  ctx: AssembledContext;
  /** Lineage for telemetry / learning loop attribution. */
  factIds: string[];
  exemplarIds: string[];
  personaVersion: number | null;
}

/** Prefer the mission's persona; fall back to the user's default (oldest, non-archived). */
export async function resolvePersona(scope: Scope, personaId: string | null): Promise<PersonaDoc | null> {
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
  args: { contact: ContactDoc; target: TargetDoc; mission: MissionDoc; persona: PersonaDoc | null }
): Promise<AssembledBundle> {
  const { contact, target, mission, persona } = args;

  const facts = await assembleAllowedFacts(scope, uid, persona?._id ?? null, target._id, mission.goal, {
    excludedFactIds: persona?.excludedFactIds ?? [],
  });
  const exemplarDocs = persona ? await fetchExemplars(uid, persona._id, mission.goal) : [];
  // Sender identity - anchors a real sign-off on every email (engine.ts).
  const profile = await scope.collection<ProfileDoc>('profiles').findOne();

  const ctx: AssembledContext = {
    mode: mission.mode ?? 'sales',
    recipient: { name: contact.name, role: contact.role, company: target.companyName },
    sender: { name: profile?.name ?? null, role: profile?.role ?? null, organization: profile?.organization ?? null },
    missionGoal: mission.goal,
    audience: mission.targetDescription,
    whyNow: target.whyNow ?? undefined,
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
 * `allowedFacts` = the persona's context bank (person- + persona-scoped, relevance-
 * ranked) + the target's latest evidence bullets. Evidence ids are stable strings
 * (`evidence:<packId>:<index>`) so claims can cite them. Vector search narrows a
 * large bank; on any failure it falls back to recency so grounding still exists.
 */
export async function assembleAllowedFacts(
  scope: Scope,
  uid: string,
  personaId: string | null,
  targetId: string,
  missionGoal: string,
  opts: { excludedFactIds?: string[] } = {}
): Promise<AllowedFact[]> {
  const facts: AllowedFact[] = [];
  // Default (person-level) facts this voice opted out of - drop them from
  // grounding so a cleared default never resurfaces in a generated email.
  const excluded = new Set(opts.excludedFactIds ?? []);

  const ranked = await fetchRankedContextFacts(uid, personaId, missionGoal);
  let contextFacts = ranked;
  if (contextFacts === null) {
    const candidates = await scope.collection<ContextFactDoc>('context_facts').find(
      personaId
        ? ({ $or: [{ scope: 'person' }, { scope: 'persona', personaId }] } as Record<string, unknown>)
        : { scope: 'person' }
    );
    candidates.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    contextFacts = candidates.slice(0, MAX_FACTS);
  }
  for (const f of contextFacts) {
    if (excluded.has(f._id)) continue;
    facts.push({ id: f._id, claim: f.claim, source: 'context_fact' });
  }

  const packs = await scope.collection<EvidencePackDoc>('evidence_packs').find({ targetId });
  packs.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  const latestPack = packs[0];
  if (latestPack) {
    latestPack.bullets.forEach((b, i) => {
      facts.push({ id: `evidence:${latestPack._id}:${i}`, claim: b.fact, source: 'evidence' });
    });
  }

  return facts;
}

/** Relevance-rank the context bank via Atlas Vector Search. null ⇒ unavailable. */
async function fetchRankedContextFacts(
  uid: string,
  personaId: string | null,
  missionGoal: string
): Promise<Array<{ _id: string; claim: string }> | null> {
  try {
    const queryVector = await embedOne(missionGoal, 'query');
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
    if (personaId) runs.push(search({ userId: uid, scope: 'persona', personaId }));
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
  uid: string,
  personaId: string,
  missionGoal: string
): Promise<Array<{ id: string; subject: string | null; body: string }>> {
  try {
    const queryVector = await embedOne(missionGoal, 'query');
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
  const recent = await forUser(uid).collection<StyleExemplarDoc>('style_exemplars').find({ personaId });
  recent.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
  return recent.slice(0, MAX_EXEMPLARS).map((e) => ({ id: e._id, subject: e.subject, body: e.body }));
}
