// Contact-quality eval — the gate that decides Fix 3 is "done". Runs offline on
// recorded LinkedIn SERP fixtures: serpResultToSuggestion → rankCandidates, then
// measures whether the RIGHT person for the mission lands at the top.
//
// Bar (the "right person for the mission" standard):
//   • precision@1 ≥ 0.90  — the top pick is a correct contact
//   • precision@3 ≥ 0.95  — the top 3 are almost all correct contacts
//   • no mission mode below 0.80 precision@1
//
// Each failing case prints WHY (wrong person on top, right person dropped) so the
// fix is targeted, not guesswork.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, serpResultToSuggestion } from './contacts';
import { defaultContactIcp } from '../_lib/icp';
import { CONTACT_QUALITY_CASES, type QualityCase } from './__fixtures__/contact-quality';
import type { ContactIcp } from '../../shared/types';
import type { MissionDoc, TargetDoc } from '../../shared/schemas';

function icpFor(c: QualityCase): ContactIcp {
  const base = defaultContactIcp(c.mode, c.geo ?? null);
  if (!c.extraFunctions?.length) return base;
  // Mimic the per-mission ICP synthesizer adding audience-specific functions.
  return {
    ...base,
    functions: [...base.functions, ...c.extraFunctions],
    functionKeywords: [...base.functionKeywords, ...c.extraFunctions],
  };
}

interface CaseResult {
  id: string;
  mode: string;
  order: string[];
  right: Set<string>;
  p1: number;
  p3: number;
}

function evalCase(c: QualityCase): CaseResult {
  const icp = icpFor(c);
  const target = { _id: 't1', companyName: c.companyName } as TargetDoc;
  const mission = { _id: 'm1', mode: c.mode } as MissionDoc;
  const suggestions = c.serp.map(serpResultToSuggestion);
  const ranked = rankCandidates(suggestions, { icp, sizeTier: c.sizeTier, target, mission, profile: null });
  // Fixtures label by the (unique) first name; the engine carries full names.
  const firstName = (n: string) => n.split(/\s+/)[0];
  const order = ranked.rows.map((r) => firstName(r.name));
  const right = new Set(c.right.map(firstName));
  const top3 = order.slice(0, 3);
  const p1 = order.length > 0 && right.has(order[0]) ? 1 : 0;
  const p3 = top3.length > 0 ? top3.filter((n) => right.has(n)).length / top3.length : 0;
  return { id: c.id, mode: c.mode, order, right, p1, p3 };
}

describe('contact-quality eval — right person for the mission', () => {
  const results = CONTACT_QUALITY_CASES.map(evalCase);

  // Per-case visibility: surface the failures with their ranked order so a
  // regression names itself.
  for (const r of results) {
    it(`${r.id}: top pick is a correct contact`, () => {
      assert.equal(
        r.p1,
        1,
        `top pick "${r.order[0] ?? '(none)'}" is not in right={${[...r.right].join(', ')}}; ranked order = [${r.order.join(', ')}]`
      );
    });
  }

  it('meets the aggregate bar (p@1 ≥ 0.90, p@3 ≥ 0.95)', () => {
    const n = results.length;
    const p1 = results.reduce((a, r) => a + r.p1, 0) / n;
    const p3 = results.reduce((a, r) => a + r.p3, 0) / n;
    // eslint-disable-next-line no-console
    console.log(`contact-quality: cases=${n} precision@1=${p1.toFixed(3)} precision@3=${p3.toFixed(3)}`);
    assert.ok(p1 >= 0.9, `precision@1 ${p1.toFixed(3)} < 0.90`);
    assert.ok(p3 >= 0.95, `precision@3 ${p3.toFixed(3)} < 0.95`);
  });

  it('no mission mode below 0.80 precision@1', () => {
    const byMode = new Map<string, { hit: number; n: number }>();
    for (const r of results) {
      const m = byMode.get(r.mode) ?? { hit: 0, n: 0 };
      m.hit += r.p1;
      m.n += 1;
      byMode.set(r.mode, m);
    }
    for (const [mode, { hit, n }] of byMode) {
      const p = hit / n;
      // eslint-disable-next-line no-console
      console.log(`  mode ${mode}: precision@1=${p.toFixed(3)} (n=${n})`);
      assert.ok(p >= 0.8, `mode ${mode} precision@1 ${p.toFixed(3)} < 0.80`);
    }
  });
});
