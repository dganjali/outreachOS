import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleDraftContext, createDraftContextCache } from './assemble';
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
