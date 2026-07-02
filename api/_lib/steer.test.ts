// Unit tests for the steering patch logic - the safety layer that splits an
// agent proposal into a mission update + a recipe-stage patch. No LLM/DB: pure
// function. (Numeric clamping lives in recipe.ts and is tested in recipe.test.ts;
// here we test the mission/recipe split + fact-pin merge + snake-case normalize.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSteerUpdates, isEmptyUpdate, normalizeProposal } from './steer';
import type { SteerProposal } from '../../shared/schemas';

const mission = { draftDirective: null as string | null, emphasizedFactIds: [] as string[] };

function prop(over: Partial<SteerProposal>): SteerProposal {
  return { changes: [], ...over };
}

test('recipe stage fields are forwarded as a patch', () => {
  const { recipePatch } = buildSteerUpdates(
    mission,
    prop({ recipe: { personSourcing: { contactsPerCompany: 3, seniority: ['vp'] }, send: { dailySendCap: 25 } } })
  );
  assert.equal(recipePatch.personSourcing?.contactsPerCompany, 3);
  assert.deepEqual(recipePatch.personSourcing?.seniority, ['vp']);
  assert.equal(recipePatch.send?.dailySendCap, 25);
});

test('mission targeting fields land on the mission update', () => {
  const { missionUpdate } = buildSteerUpdates(
    mission,
    prop({ mission: { goal: 'Sell X', targetDescription: 'Series B fintech', geo: 'US' } })
  );
  assert.equal(missionUpdate.goal, 'Sell X');
  assert.equal(missionUpdate.targetDescription, 'Series B fintech');
  assert.equal(missionUpdate.geo, 'US');
});

test('clearIcp nulls the cached ICP + sector suggestions', () => {
  const { missionUpdate } = buildSteerUpdates(mission, prop({ mission: { clearIcp: true } }));
  assert.equal(missionUpdate.contactIcp, null);
  assert.equal(missionUpdate.sectorSuggestions, null);
});

test('draftDirectiveAppend appends a line; draftDirective replaces', () => {
  const withExisting = { draftDirective: 'Lead with warmth.', emphasizedFactIds: [] };
  const appended = buildSteerUpdates(withExisting, prop({ mission: { draftDirectiveAppend: 'Never mention price.' } }));
  assert.equal(appended.missionUpdate.draftDirective, 'Lead with warmth.\nNever mention price.');

  const replaced = buildSteerUpdates(withExisting, prop({ mission: { draftDirective: 'Only this now.' } }));
  assert.equal(replaced.missionUpdate.draftDirective, 'Only this now.');
});

test('emphasize/deemphasize merge against the current pinned set', () => {
  const withPins = { draftDirective: null, emphasizedFactIds: ['a', 'b'] };
  const { missionUpdate } = buildSteerUpdates(withPins, prop({ emphasizeFactIds: ['c'], deemphasizeFactIds: ['a'] }));
  assert.deepEqual([...(missionUpdate.emphasizedFactIds ?? [])].sort(), ['b', 'c']);
});

test('validFactIds drops a pin the user does not own', () => {
  const { missionUpdate } = buildSteerUpdates(mission, prop({ emphasizeFactIds: ['mine', 'stranger'] }), {
    validFactIds: new Set(['mine']),
  });
  assert.deepEqual(missionUpdate.emphasizedFactIds, ['mine']);
});

test('a clarification-only proposal yields an empty update', () => {
  const u = buildSteerUpdates(mission, prop({ clarification: 'Which fact did you mean?' }));
  assert.equal(isEmptyUpdate(u), true);
});

test('a recipe-only patch is not an empty update', () => {
  const u = buildSteerUpdates(mission, prop({ recipe: { sourcing: { count: 12 } } }));
  assert.equal(isEmptyUpdate(u), false);
});

test('a snake_cased proposal (round-tripped through the data shim) still applies', () => {
  // What the frontend shim hands back after storing/reloading: nested keys are
  // snake_cased. Without normalize, buildSteerUpdates would see nothing.
  const roundTripped = {
    mission: { target_description: 'Bigger companies (Fortune 500)', clear_icp: true, draft_directive_append: 'Lead on the $20k win.' },
    recipe: { person_sourcing: { contacts_per_company: 4 }, send: { send_window: { start_hour: 8, end_hour: 18 } } },
    emphasize_fact_ids: ['f1'],
    changes: [{ label: 'Audience', from: 'a', to: 'b' }],
  };
  const proposal = normalizeProposal(roundTripped);
  assert.equal(proposal.mission?.targetDescription, 'Bigger companies (Fortune 500)');
  assert.equal(proposal.mission?.clearIcp, true);
  assert.equal(proposal.recipe?.personSourcing?.contactsPerCompany, 4);
  assert.equal(proposal.recipe?.send?.sendWindow?.startHour, 8);

  const { missionUpdate, recipePatch } = buildSteerUpdates(mission, proposal);
  assert.equal(missionUpdate.targetDescription, 'Bigger companies (Fortune 500)');
  assert.equal(missionUpdate.contactIcp, null);
  assert.equal(missionUpdate.draftDirective, 'Lead on the $20k win.');
  assert.deepEqual(missionUpdate.emphasizedFactIds, ['f1']);
  assert.equal(recipePatch.personSourcing?.contactsPerCompany, 4);
  assert.equal(isEmptyUpdate({ missionUpdate, recipePatch }), false);
});
