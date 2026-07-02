// Target-data ops (Phase 3c): the steering chat editing the discovered target
// set directly. Pure-ish - a fake scope captures the writes; no DB/LLM.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyTargetOps, hasTargetOps, type TargetAddDeps } from './steer';

// Default deps hit the network (Serper/LLM domain resolve + size enrich), so
// every applyTargetOps call injects fakes. Acme resolves to acme.com with a
// fixed size; every other name resolves no domain / null size.
function fakeDeps(overrides: Partial<TargetAddDeps> = {}): TargetAddDeps {
  return {
    resolveDomains: async () => new Map([['Acme', 'acme.com']]),
    enrichSize: async (_name, domain) => (domain === 'acme.com' ? 4200 : null),
    ...overrides,
  };
}

function fakeScope() {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const scope = {
    collection() {
      return {
        insertOne: async (doc: Record<string, unknown>) => {
          inserts.push(doc);
          return doc;
        },
        updateById: async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return 1;
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { scope: scope as any, inserts, updates };
}

describe('hasTargetOps', () => {
  it('is false for empty/absent ops and true when any op is present', () => {
    assert.equal(hasTargetOps(undefined), false);
    assert.equal(hasTargetOps({}), false);
    assert.equal(hasTargetOps({ add: [] }), false);
    assert.equal(hasTargetOps({ add: ['Acme'] }), true);
    assert.equal(hasTargetOps({ removeIds: ['t1'] }), true);
    assert.equal(hasTargetOps({ pinIds: ['t1'] }), true);
  });
});

describe('applyTargetOps', () => {
  it('removes/pins only valid ids and adds new manual targets', async () => {
    const { scope, inserts, updates } = fakeScope();
    const valid = new Set(['t1', 't2']);
    const tally = await applyTargetOps(
      scope,
      'm1',
      { removeIds: ['t1', 'stranger'], pinIds: ['t2'], add: ['Acme', ' Globex '] },
      valid,
      'some hint',
      fakeDeps()
    );

    // enriched counts the one insert (Acme) that resolved a domain.
    assert.deepEqual(tally, { added: 2, removed: 1, pinned: 1, enriched: 1 });
    // The stranger id (not owned) is dropped.
    assert.deepEqual(
      updates.map((u) => ({ id: u.id, status: u.patch.status })).sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: 't1', status: 'rejected' },
        { id: 't2', status: 'approved' },
      ]
    );
    // Added targets are manual, suggested, and carry the mission id + trimmed name.
    assert.equal(inserts.length, 2);
    assert.deepEqual(inserts.map((d) => d.companyName), ['Acme', 'Globex']);
    assert.ok(inserts.every((d) => d.missionId === 'm1' && d.source === 'manual' && d.status === 'suggested'));
    // Acme carries the resolved domain + faked size; Globex resolved nothing but
    // still inserts bare (best-effort).
    const acme = inserts.find((d) => d.companyName === 'Acme')!;
    const globex = inserts.find((d) => d.companyName === 'Globex')!;
    assert.equal(acme.domain, 'acme.com');
    assert.equal(acme.employeeCount, 4200);
    assert.equal(globex.domain, null);
    assert.equal(globex.employeeCount, null);
  });

  it('dedupes + caps added names', async () => {
    const { scope, inserts } = fakeScope();
    const many = Array.from({ length: 15 }, (_, i) => `Co ${i}`);
    const tally = await applyTargetOps(
      scope,
      'm1',
      { add: ['Dup', 'Dup', ...many] },
      new Set(),
      undefined,
      fakeDeps({ resolveDomains: async () => new Map() })
    );
    assert.equal(tally.added, 10); // MAX_TARGETS_ADD
    assert.equal(tally.enriched, 0); // no domain resolved
    assert.equal(inserts.length, 10);
  });

  it('inserts bare when the domain resolver rejects (batch-level try/catch)', async () => {
    const { scope, inserts } = fakeScope();
    let calls = 0;
    let seenNames: string[] = [];
    const tally = await applyTargetOps(
      scope,
      'm1',
      { add: ['Acme', 'Globex', 'Initech'] },
      new Set(),
      'hint',
      fakeDeps({
        resolveDomains: async (companies) => {
          calls++;
          seenNames = companies.map((c) => c.name);
          throw new Error('resolver down');
        },
      })
    );

    // All names still insert, bare (no domain / size), and none count as enriched.
    assert.deepEqual(tally, { added: 3, removed: 0, pinned: 0, enriched: 0 });
    assert.equal(inserts.length, 3);
    assert.ok(inserts.every((d) => d.domain === null && d.employeeCount === null));
    // resolveDomains is called exactly once, batched with every name.
    assert.equal(calls, 1);
    assert.deepEqual(seenNames, ['Acme', 'Globex', 'Initech']);
  });
});
