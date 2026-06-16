import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultContactIcp, normalizeIcp, buildContactTypeOptions, MODE_ICP_PRIOR } from './icp';
import { SENIORITY_RANK } from './seniority';
import type { MissionMode, SeniorityLevel } from '../../shared/types';

const MODES: MissionMode[] = ['sponsorship', 'bd', 'internship', 'recruiting', 'sales'];

describe('defaultContactIcp', () => {
  for (const mode of MODES) {
    it(`produces a valid, non-empty ICP for ${mode}`, () => {
      const icp = defaultContactIcp(mode);
      assert.ok(icp.functions.length > 0);
      assert.ok(icp.functionKeywords.length > 0);
      assert.ok(icp.seniority.idealLevels.length > 0);
      assert.ok(icp.seniority.maxLevel);
      assert.equal(icp.geo.preferred, null);
    });
  }

  it('applies the geo preference', () => {
    const icp = defaultContactIcp('sponsorship', '  Toronto, CA ');
    assert.equal(icp.geo.preferred, 'Toronto, CA');
  });

  it('recruiting excludes in-house recruiters/HR (candidate-sourcing model)', () => {
    const icp = defaultContactIcp('recruiting');
    for (const kw of ['recruiter', 'talent acquisition', 'human resources']) {
      assert.ok(icp.disqualifierKeywords.includes(kw), `expected disqualifier "${kw}"`);
    }
    // and it aims at ICs/leads, not execs
    assert.ok(icp.seniority.idealLevels.every((l) => ['ic', 'senior_ic', 'lead'].includes(l)));
  });

  it('owner-band modes cap at director', () => {
    assert.equal(MODE_ICP_PRIOR.sponsorship.seniority.maxLevel, 'director');
    assert.equal(MODE_ICP_PRIOR.bd.seniority.maxLevel, 'director');
  });
});

describe('normalizeIcp', () => {
  it('returns the default when raw is null', () => {
    const icp = normalizeIcp('sponsorship', null, null);
    assert.deepEqual(icp.functions, defaultContactIcp('sponsorship').functions);
  });

  it('merges LLM functions on top of the prior and dedupes', () => {
    const icp = normalizeIcp('sponsorship', 'Berlin', {
      functions: ['diversity & inclusion', 'community'],
      function_keywords: ['d&i', 'community'],
      disqualifier_keywords: ['contractor'],
      geo_scope: 'metro',
      rationale: 'D&I leads own this hackathon sponsorship',
    });
    assert.ok(icp.functions.includes('diversity & inclusion'));
    assert.ok(icp.functions.includes('community'));
    // community appears once despite being in both LLM + prior
    assert.equal(icp.functions.filter((f) => f === 'community').length, 1);
    assert.ok(icp.disqualifierKeywords.includes('contractor'));
    assert.equal(icp.geo.scope, 'metro');
    assert.equal(icp.geo.preferred, 'Berlin');
  });

  it('NEVER lets the LLM change the seniority band (prior wins)', () => {
    const icp = normalizeIcp('sponsorship', null, {
      functions: ['community'],
      // even if the model tried to smuggle seniority in, it can't:
    } as never);
    assert.deepEqual(icp.seniority, MODE_ICP_PRIOR.sponsorship.seniority);
  });

  it('ignores an invalid geo_scope', () => {
    const icp = normalizeIcp('sales', null, { functions: ['ops'], geo_scope: 'galaxy' } as never);
    assert.equal(icp.geo.scope, 'global'); // falls back to default
  });
});

describe('buildContactTypeOptions', () => {
  it('maps every ICP function to a recommended option, ids unique', () => {
    const icp = defaultContactIcp('sponsorship');
    const { functions } = buildContactTypeOptions(icp);
    assert.equal(functions.length, icp.functions.length);
    assert.ok(functions.every((o) => o.kind === 'function' && o.recommended));
    assert.equal(new Set(functions.map((o) => o.id)).size, functions.length);
    // values round-trip back to the raw ICP functions
    assert.deepEqual(functions.map((o) => o.value), icp.functions);
  });

  it('offers the ideal band (recommended) and lets the user widen up to maxLevel', () => {
    const icp = defaultContactIcp('sponsorship'); // ideal manager..director, cap director
    const { seniority } = buildContactTypeOptions(icp);
    const byValue = new Map(seniority.map((o) => [o.value, o]));
    // every ideal level present and pre-checked
    for (const lvl of icp.seniority.idealLevels) {
      assert.ok(byValue.get(lvl)?.recommended, `expected ${lvl} recommended`);
    }
    // never offers anything above the hard cap
    assert.ok(!seniority.some((o) => o.value === 'vp' || o.value === 'cxo' || o.value === 'founder'));
    // sorted junior → senior
    const ranks = seniority.map((o) => SENIORITY_RANK[o.value as SeniorityLevel]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  });
});
