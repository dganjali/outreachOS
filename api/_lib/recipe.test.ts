import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecipeStages,
  policyView,
  pipelineConfigFromRecipe,
} from './recipe';
import { POLICY_DEFAULTS } from './autopilot';
import { DEFAULT_TARGET_COUNT, DEFAULT_TOP_N, DEFAULT_TOP_CONTACTS } from './pipeline';
import type { CampaignPolicyDoc, PipelineRunDoc } from '../../shared/schemas';

describe('buildRecipeStages - defaults reproduce pre-Phase-3 behavior', () => {
  it('a fresh company mission with no policy/prior config yields the manual defaults', () => {
    const r = buildRecipeStages({ mission: { findMode: null } });
    assert.equal(r.automationEnabled, false);
    assert.equal(r.sourcing.findMode, 'companies');
    assert.equal(r.sourcing.count, DEFAULT_TARGET_COUNT);
    assert.equal(r.sourcing.topN, DEFAULT_TOP_N);
    assert.equal(r.personSourcing.contactsPerCompany, DEFAULT_TOP_CONTACTS);
    assert.deepEqual(r.personSourcing.functions, []);
    assert.deepEqual(r.personSourcing.seniority, []);
    assert.deepEqual(r.sourcing.sectors, []);
    assert.equal(r.send.autoSend, POLICY_DEFAULTS.autoSend);
    assert.equal(r.send.dailySendCap, POLICY_DEFAULTS.dailySendCap);
    assert.equal(r.send.cycleIntervalHours, POLICY_DEFAULTS.cycleIntervalHours);
    assert.equal(r.verification.minConfidence, POLICY_DEFAULTS.minConfidence);
    assert.deepEqual(r.send.sendWindow, POLICY_DEFAULTS.sendWindow);
  });

  it('people mode pins one contact per target', () => {
    const r = buildRecipeStages({ mission: { findMode: 'people' } });
    assert.equal(r.sourcing.findMode, 'people');
    assert.equal(r.personSourcing.contactsPerCompany, 1);
  });

  it('migrating a legacy policy folds the old fields into send/verification + counts', () => {
    const policy: Partial<CampaignPolicyDoc> = {
      enabled: true,
      autoSend: true,
      targetsPerCycle: 7,
      cycleIntervalHours: 12,
      dailySendCap: 25,
      minConfidence: 0.8,
      timezone: 'America/New_York',
      sendWindow: { startHour: 8, endHour: 18 },
      lastSourcedAt: new Date('2026-06-01T00:00:00Z'),
      counter: { date: '2026-06-01', sent: 3 },
    };
    const r = buildRecipeStages({ mission: { findMode: null }, policy });
    assert.equal(r.automationEnabled, true);
    // targetsPerCycle drove topN and the (max'd) targetCount, exactly as before.
    assert.equal(r.sourcing.topN, 7);
    assert.equal(r.sourcing.count, Math.max(7, DEFAULT_TARGET_COUNT));
    assert.equal(r.send.autoSend, true);
    assert.equal(r.send.cycleIntervalHours, 12);
    assert.equal(r.send.dailySendCap, 25);
    assert.equal(r.verification.minConfidence, 0.8);
    assert.equal(r.send.timezone, 'America/New_York');
    assert.deepEqual(r.send.sendWindow, { startHour: 8, endHour: 18 });
    assert.deepEqual(r.send.counter, { date: '2026-06-01', sent: 3 });
    assert.equal(r.send.lastSourcedAt?.toISOString(), '2026-06-01T00:00:00.000Z');
  });

  it('preserves person/sector selections the autopilot used to inherit from the last run', () => {
    const priorConfig = {
      targetCount: 12,
      topN: 6,
      topContacts: 3,
      selectedFunctions: ['sales', 'marketing'],
      selectedSeniority: ['vp', 'cxo'],
      selectedSectors: ['fintech'],
    } as PipelineRunDoc['config'];
    const r = buildRecipeStages({ mission: { findMode: null }, priorConfig });
    assert.equal(r.personSourcing.contactsPerCompany, 3);
    assert.deepEqual(r.personSourcing.functions, ['sales', 'marketing']);
    assert.deepEqual(r.personSourcing.seniority, ['vp', 'cxo']);
    assert.deepEqual(r.sourcing.sectors, ['fintech']);
    assert.equal(r.sourcing.count, 12);
  });
});

describe('buildRecipeStages - clamps', () => {
  it('clamps out-of-range numerics to sane bounds', () => {
    const r = buildRecipeStages({
      mission: { findMode: null },
      partial: {
        sourcing: { type: 'sourcing', enabled: true, provider: 'web_search', findMode: 'companies', count: 999, topN: 999, sectors: [] },
        personSourcing: { type: 'personSourcing', enabled: true, contactsPerCompany: 99, functions: [], seniority: [] },
        send: {
          type: 'send', enabled: true, autoSend: true, cycleIntervalHours: 0, dailySendCap: 100000,
          sendWindow: { startHour: 20, endHour: 5 }, timezone: 'UTC', lastSourcedAt: null, counter: null,
        },
        verification: { type: 'verification', enabled: true, emailVerify: true, contactVerify: true, minConfidence: 5 },
      },
    });
    assert.equal(r.sourcing.count, 25);
    assert.equal(r.sourcing.topN, 15);
    assert.equal(r.personSourcing.contactsPerCompany, 5);
    assert.equal(r.send.cycleIntervalHours, 1);
    assert.equal(r.send.dailySendCap, 100);
    assert.equal(r.verification.minConfidence, 1);
    // An inverted window is rejected and falls back to the default.
    assert.deepEqual(r.send.sendWindow, POLICY_DEFAULTS.sendWindow);
  });

  it('dedupes + trims functions and drops invalid seniority levels', () => {
    const r = buildRecipeStages({
      mission: { findMode: null },
      partial: {
        personSourcing: {
          type: 'personSourcing', enabled: true, contactsPerCompany: 2,
          functions: [' Sales ', 'sales', 'Marketing'],
          seniority: ['vp', 'not_a_level' as never, 'cxo'],
        },
      },
    });
    assert.deepEqual(r.personSourcing.functions, ['Sales', 'Marketing']);
    assert.deepEqual(r.personSourcing.seniority, ['vp', 'cxo']);
  });
});

describe('policyView + pipelineConfigFromRecipe', () => {
  it('policyView flattens send + verification into the SendPolicy shape', () => {
    const stages = buildRecipeStages({
      mission: { findMode: null },
      policy: { enabled: true, autoSend: true, minConfidence: 0.75, dailySendCap: 20 },
    });
    const view = policyView(stages);
    assert.equal(view.enabled, true);
    assert.equal(view.autoSend, true);
    assert.equal(view.minConfidence, 0.75);
    assert.equal(view.dailySendCap, 20);
    assert.equal(view.timezone, stages.send.timezone);
  });

  it('pipelineConfigFromRecipe maps stages onto the run config shape', () => {
    const stages = buildRecipeStages({
      mission: { findMode: null },
      priorConfig: {
        targetCount: 10, topN: 4, topContacts: 2,
        selectedFunctions: ['eng'], selectedSeniority: ['director'], selectedSectors: ['saas'],
      } as PipelineRunDoc['config'],
    });
    const cfg = pipelineConfigFromRecipe(stages);
    assert.equal(cfg.targetCount, 10);
    assert.equal(cfg.topN, 4);
    assert.equal(cfg.topContacts, 2);
    assert.deepEqual(cfg.selectedFunctions, ['eng']);
    assert.deepEqual(cfg.selectedSeniority, ['director']);
    assert.deepEqual(cfg.selectedSectors, ['saas']);
  });
});
