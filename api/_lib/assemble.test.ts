import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleDraftContext, assembleAllowedFacts, buildRetrievalQuery, createDraftContextCache } from './assemble';
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

function now() {
  return new Date('2026-01-01T00:00:00Z');
}

function fakeScope() {
  const calls = new Map<string, number>();
  const hit = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);

  const profile = {
    _id: 'profile1',
    userId: 'u1',
    createdAt: now(),
    updatedAt: now(),
    name: 'Sender One',
    role: 'Founder',
    organization: 'OutreachOS',
  } as ProfileDoc;

  const contextFact = {
    _id: 'fact1',
    userId: 'u1',
    createdAt: now(),
    updatedAt: now(),
    scope: 'person',
    personaId: null,
    type: 'proof',
    claim: 'Sender runs a 1,400-person developer event',
    date: null,
    evidenceUrl: null,
    provenance: 'manual',
    confidence: 1,
  } as ContextFactDoc;

  const exemplars = [
    {
      _id: 'ex1',
      userId: 'u1',
      createdAt: now(),
      updatedAt: now(),
      personaId: 'persona1',
      subject: 'quick thought',
      body: 'Short, specific, plainspoken.',
      mode: 'sales',
      source: 'user-provided',
      outcome: 'unknown',
    },
  ] as StyleExemplarDoc[];

  const packs = [
    {
      _id: 'pack1',
      userId: 'u1',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: now(),
      targetId: 'target1',
      missionId: 'mission1',
      bullets: [{ fact: 'Target One launched a partner program', sourceUrl: 'https://one.test', sourceTitle: 'One', signalType: 'launch', recency: 'recent' }],
      citations: [],
    },
    {
      _id: 'pack2',
      userId: 'u1',
      createdAt: new Date('2026-01-02T00:00:00Z'),
      updatedAt: now(),
      targetId: 'target2',
      missionId: 'mission1',
      bullets: [{ fact: 'Target Two hired a new partnerships lead', sourceUrl: 'https://two.test', sourceTitle: 'Two', signalType: 'hire', recency: 'recent' }],
      citations: [],
    },
  ] as EvidencePackDoc[];

  const collections: Record<string, unknown[]> = {
    profiles: [profile],
    context_facts: [contextFact],
    style_exemplars: exemplars,
    evidence_packs: packs,
  };

  return {
    calls,
    scope: {
      collection(name: string) {
        return {
          find: async (filter: Record<string, unknown> = {}) => {
            hit(`${name}.find`);
            const rows = collections[name] ?? [];
            if (name === 'evidence_packs' && filter.targetId) return rows.filter((r) => (r as EvidencePackDoc).targetId === filter.targetId);
            if (name === 'style_exemplars' && filter.personaId) return rows.filter((r) => (r as StyleExemplarDoc).personaId === filter.personaId);
            return rows;
          },
          findOne: async () => {
            hit(`${name}.findOne`);
            return (collections[name] ?? [])[0] ?? null;
          },
        };
      },
    },
  };
}

test('draft-context cache reuses mission/persona lookups while keeping target evidence distinct', async () => {
  const { scope, calls } = fakeScope();
  const cache = createDraftContextCache();
  const mission = {
    _id: 'mission1',
    mode: 'sales',
    goal: 'Sell the offer',
    targetDescription: 'Developer tools companies',
    personaId: 'persona1',
  } as MissionDoc;
  const persona = {
    _id: 'persona1',
    styleProfile: emptyStyleProfile(),
    styleProfileVersion: 2,
    excludedFactIds: [],
  } as unknown as PersonaDoc;

  const one = await assembleDraftContext(
    scope as never,
    'u1',
    {
      contact: { _id: 'contact1', name: 'A One', role: 'Partnerships', targetId: 'target1' } as ContactDoc,
      target: { _id: 'target1', companyName: 'Target One', whyNow: null } as TargetDoc,
      mission,
      persona,
    },
    cache
  );
  const two = await assembleDraftContext(
    scope as never,
    'u1',
    {
      contact: { _id: 'contact2', name: 'B Two', role: 'Partnerships', targetId: 'target2' } as ContactDoc,
      target: { _id: 'target2', companyName: 'Target Two', whyNow: null } as TargetDoc,
      mission,
      persona,
    },
    cache
  );

  assert.equal(calls.get('profiles.findOne'), 1);
  assert.equal(calls.get('context_facts.find'), 1);
  assert.equal(calls.get('style_exemplars.find'), 1);
  assert.equal(calls.get('evidence_packs.find'), 2);
  assert.ok(one.factIds.includes('fact1'));
  assert.ok(two.factIds.includes('fact1'));
  assert.ok(one.factIds.includes('evidence:pack1:0'));
  assert.ok(!one.factIds.includes('evidence:pack2:0'));
  assert.ok(two.factIds.includes('evidence:pack2:0'));
  assert.ok(!two.factIds.includes('evidence:pack1:0'));
});

// ---------------------------------------------------------------------------
// Allowed-fact scope contract: a draft grounds on the person-level memory bank
// PLUS only THIS mission's facts - never another mission's, never legacy
// persona-scoped facts. Vector search is unavailable in tests, so this exercises
// the recency fallback path (the $or query in loadContextAllowedFacts).
// ---------------------------------------------------------------------------

function factScope(facts: Array<Partial<ContextFactDoc> & { _id: string; scope: string }>) {
  const matches = (f: { scope: string; missionId?: string | null }, filter: Record<string, unknown>): boolean => {
    const clauses = (filter.$or as Array<Record<string, unknown>> | undefined) ?? [filter];
    return clauses.some((c) =>
      Object.entries(c).every(([k, v]) => (f as Record<string, unknown>)[k] === v)
    );
  };
  return {
    collection(name: string) {
      return {
        find: async (filter: Record<string, unknown> = {}) =>
          name === 'context_facts' ? facts.filter((f) => matches(f, filter)) : [],
        findOne: async () => null,
      };
    },
  };
}

test('allowed facts include person + this mission, exclude other missions and persona-legacy', async () => {
  const mk = (id: string, scope: string, claim: string, missionId: string | null = null) => ({
    _id: id,
    userId: 'u1',
    scope,
    missionId,
    personaId: null,
    type: 'proof',
    claim,
    createdAt: now(),
    updatedAt: now(),
  });
  const scope = factScope([
    mk('mem1', 'person', 'Sender runs a 1,400-person event'),
    mk('mis1', 'mission', 'This campaign offers a gold tier at $5k', 'missionA'),
    mk('other', 'mission', 'A different campaign fact', 'missionB'),
    mk('legacy', 'persona', 'Legacy voice-owned fact'),
  ]);

  const facts = await assembleAllowedFacts(scope as never, 'u1', 'missionA', 'targetX', 'Sell the offer');
  const ids = facts.map((f) => f.id);
  assert.ok(ids.includes('mem1'), 'memory-bank fact included');
  assert.ok(ids.includes('mis1'), "this mission's fact included");
  assert.ok(!ids.includes('other'), "another mission's fact excluded");
  assert.ok(!ids.includes('legacy'), 'legacy persona-scoped fact excluded');
});

// ---------------------------------------------------------------------------
// buildRetrievalQuery - per-recipient ranking key (diversity lever).
// ---------------------------------------------------------------------------

test('buildRetrievalQuery folds the recipient role + headline into the query', () => {
  const q = buildRetrievalQuery({ missionGoal: 'Sell the offer', role: 'VP Engineering', headline: 'Scaling infra' });
  assert.ok(q.includes('Sell the offer'));
  assert.ok(q.includes('VP Engineering'));
  assert.ok(q.includes('Scaling infra'));
});

test('buildRetrievalQuery degrades to the bare goal when the recipient is anonymous', () => {
  assert.equal(buildRetrievalQuery({ missionGoal: 'Sell the offer' }), 'Sell the offer');
  assert.equal(buildRetrievalQuery({ missionGoal: 'Sell the offer', role: '', headline: null }), 'Sell the offer');
});

// ---------------------------------------------------------------------------
// Evidence ranking - keep the strongest few, not every bullet, and preserve the
// original index so the citation id still resolves.
// ---------------------------------------------------------------------------

function evidenceOnlyScope(bullets: EvidencePackDoc['bullets']) {
  const pack = {
    _id: 'packX',
    userId: 'u1',
    createdAt: now(),
    updatedAt: now(),
    targetId: 'targetX',
    missionId: 'missionX',
    bullets,
    citations: [],
  } as EvidencePackDoc;
  return {
    collection(name: string) {
      return {
        find: async (filter: Record<string, unknown> = {}) => {
          if (name === 'evidence_packs' && filter.targetId === 'targetX') return [pack];
          return [];
        },
        findOne: async () => null,
      };
    },
  };
}

const b = (fact: string, signalType: string, recency: string) => ({
  fact,
  sourceUrl: 'https://x.test',
  sourceTitle: 'X',
  signalType,
  recency,
});

test('evidence ranking caps to the strongest five and keeps the best signal first', async () => {
  const bullets = [
    b('Posted a blog about culture', 'blog', 'last year'), // weak: idx 0
    b('Raised a $30M Series B', 'funding', '2 weeks ago'), // strong: idx 1
    b('Spoke at a meetup', 'talk', 'last year'), // weak: idx 2
    b('Launched a new API', 'launch', 'this week'), // strong: idx 3
    b('Hired a Head of Partnerships', 'hiring', 'last month'), // strong: idx 4
    b('Updated their About page', 'other', 'last year'), // weakest: idx 5
    b('Won a press award', 'press', 'last year'), // mid: idx 6
  ] as EvidencePackDoc['bullets'];

  const facts = await assembleAllowedFacts(evidenceOnlyScope(bullets) as never, 'u1', null, 'targetX', 'Sell the offer');
  const evidence = facts.filter((f) => f.source === 'evidence');

  // Capped to MAX_EVIDENCE (5), not all 7.
  assert.equal(evidence.length, 5);
  // A fresh, top-value signal leads (funding + launch tie on score; stable sort
  // keeps the earlier index, funding, first); the stale "other" bullet is dropped.
  assert.equal(evidence[0].id, 'evidence:packX:1'); // funding · 2 weeks ago
  assert.ok(evidence.some((f) => f.id === 'evidence:packX:3')); // launch kept too
  assert.ok(!evidence.some((f) => f.id === 'evidence:packX:5')); // dropped weakest ("other", last year)
  // Signal + recency are carried through for the writer to weigh.
  assert.equal(evidence[0].signal, 'funding');
  assert.equal(evidence[0].recency, '2 weeks ago');
});
