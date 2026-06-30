// Unit tests for the steering patch logic - the safety layer that turns an
// agent proposal into clamped, validated DB updates. No LLM/DB: pure function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteerUpdates, isEmptyUpdate, normalizeProposal } from './steer';
import { MAX_DAILY_SEND_CAP, MAX_TARGETS_PER_CYCLE } from './autopilot';
import type { SteerProposal } from '../../shared/schemas';

const mission = { draftDirective: null as string | null, emphasizedFactIds: [] as string[] };
const policy = {}; // presence is all buildSteerUpdates needs

function prop(over: Partial<SteerProposal>): SteerProposal {
  return { changes: [], ...over };
}

test('out-of-range policy numbers are clamped to sane bounds', () => {
  const { policyUpdate } = buildSteerUpdates(mission, policy, prop({
    policy: { dailySendCap: 9999, minConfidence: 5, cycleIntervalHours: 1_000_000, targetsPerCycle: 9999 },
  }));
  assert.equal(policyUpdate.dailySendCap, MAX_DAILY_SEND_CAP);
  assert.equal(policyUpdate.minConfidence, 1);
  assert.equal(policyUpdate.targetsPerCycle, MAX_TARGETS_PER_CYCLE);
  assert.equal(policyUpdate.cycleIntervalHours, 24 * 14);
});

test('negative / NaN policy numbers clamp to the low bound', () => {
  const { policyUpdate } = buildSteerUpdates(mission, policy, prop({
    policy: { minConfidence: -3, dailySendCap: Number.NaN },
  }));
  assert.equal(policyUpdate.minConfidence, 0);
  assert.equal(policyUpdate.dailySendCap, 1);
});

test('policy changes are ignored when the mission has no policy', () => {
  const { policyUpdate } = buildSteerUpdates(mission, null, prop({ policy: { dailySendCap: 20 } }));
  assert.deepEqual(policyUpdate, {});
});

test('sectors become recommended sectorSuggestions', () => {
  const { missionUpdate } = buildSteerUpdates(mission, policy, prop({ mission: { sectors: ['fintech', ' devtools '] } }));
  assert.deepEqual(missionUpdate.sectorSuggestions, [
    { name: 'fintech', recommended: true },
    { name: 'devtools', recommended: true },
  ]);
});

test('clearIcp nulls the cached ICP and (absent explicit sectors) the sectors', () => {
  const { missionUpdate } = buildSteerUpdates(mission, policy, prop({ mission: { clearIcp: true } }));
  assert.equal(missionUpdate.contactIcp, null);
  assert.equal(missionUpdate.sectorSuggestions, null);
});

test('clearIcp keeps explicit sectors when both are set', () => {
  const { missionUpdate } = buildSteerUpdates(mission, policy, prop({ mission: { clearIcp: true, sectors: ['fintech'] } }));
  assert.equal(missionUpdate.contactIcp, null);
  assert.deepEqual(missionUpdate.sectorSuggestions, [{ name: 'fintech', recommended: true }]);
});

test('draftDirectiveAppend appends a line; draftDirective replaces', () => {
  const withExisting = { draftDirective: 'Lead with warmth.', emphasizedFactIds: [] };
  const appended = buildSteerUpdates(withExisting, policy, prop({ mission: { draftDirectiveAppend: 'Never mention price.' } }));
  assert.equal(appended.missionUpdate.draftDirective, 'Lead with warmth.\nNever mention price.');

  const replaced = buildSteerUpdates(withExisting, policy, prop({ mission: { draftDirective: 'Only this now.' } }));
  assert.equal(replaced.missionUpdate.draftDirective, 'Only this now.');
});

test('emphasize/deemphasize merge against the current pinned set', () => {
  const withPins = { draftDirective: null, emphasizedFactIds: ['a', 'b'] };
  const { missionUpdate } = buildSteerUpdates(withPins, policy, prop({ emphasizeFactIds: ['c'], deemphasizeFactIds: ['a'] }));
  assert.deepEqual([...(missionUpdate.emphasizedFactIds ?? [])].sort(), ['b', 'c']);
});

test('validFactIds drops a pin the user does not own', () => {
  const { missionUpdate } = buildSteerUpdates(mission, policy, prop({ emphasizeFactIds: ['mine', 'stranger'] }), {
    validFactIds: new Set(['mine']),
  });
  assert.deepEqual(missionUpdate.emphasizedFactIds, ['mine']);
});

test('a clarification-only proposal yields an empty update', () => {
  const u = buildSteerUpdates(mission, policy, prop({ clarification: 'Which fact did you mean?' }));
  assert.equal(isEmptyUpdate(u), true);
});

test('a snake_cased proposal (round-tripped through the data shim) still applies', () => {
  // What the frontend shim hands back after storing/reloading: nested keys are
  // snake_cased. Without normalize, buildSteerUpdates would see nothing.
  const roundTripped = {
    mission: { target_description: 'Bigger companies (Fortune 500)', clear_icp: true, draft_directive_append: 'Lead on the $20k win.' },
    emphasize_fact_ids: ['f1'],
    changes: [{ label: 'Audience', from: 'a', to: 'b' }],
  };
  const proposal = normalizeProposal(roundTripped);
  assert.equal(proposal.mission?.targetDescription, 'Bigger companies (Fortune 500)');
  assert.equal(proposal.mission?.clearIcp, true);

  const { missionUpdate } = buildSteerUpdates(mission, policy, proposal);
  assert.equal(missionUpdate.targetDescription, 'Bigger companies (Fortune 500)');
  assert.equal(missionUpdate.contactIcp, null);
  assert.equal(missionUpdate.draftDirective, 'Lead on the $20k win.');
  assert.deepEqual(missionUpdate.emphasizedFactIds, ['f1']);
  assert.equal(isEmptyUpdate({ missionUpdate, policyUpdate: {} }), false);
});
