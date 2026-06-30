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
import { rankCandidates, serpResultToSuggestion, resolvePoolWithBudget, fillWithVettedDisplayOnly, type ResolvePoolDeps } from './contacts';
import { defaultContactIcp } from '../_lib/icp';
import { CONTACT_QUALITY_CASES, type QualityCase } from './__fixtures__/contact-quality';
import type { ContactIcp } from '../../shared/types';
import type { ContactDoc, MissionDoc, TargetDoc } from '../../shared/schemas';
import type { ResolvedEmail } from '../_lib/email-resolver';
import type { ContactVerification } from '../_lib/contact-verify';

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

// ---------------------------------------------------------------------------
// Coverage / recall — the other half of the bar. Precision (above) proves the
// RIGHT person ranks first; this proves we actually SURFACE a contact for the
// company through the resolve+fill path, including the two segments that used to
// come back empty: a catch-all domain (finder hit ⇒ 'likely') and a domain where
// no address resolves at all (display-only, under the recipient-fit gate). Runs
// end-to-end (rank → resolve → fill) on injected fakes, no network.
// ---------------------------------------------------------------------------

type ContactRow = Omit<ContactDoc, '_id' | 'userId' | 'createdAt' | 'updatedAt'>;
const firstName = (n: string) => n.split(/\s+/)[0];

const emptyScrape = { domain: 'co.example', emails: [], pattern: null, pagesScraped: [] };
// Catch-all domain: every candidate resolves to a 'likely' (not 'verified') email.
const catchAllDeps: ResolvePoolDeps = {
  scrape: async () => emptyScrape,
  resolve: async (name, domain): Promise<ResolvedEmail> => ({
    email: `${firstName(name).toLowerCase()}@${domain}`,
    emailStatus: 'likely',
    likelyEmailPattern: null,
    resolver: 'verifier',
  }),
};
// No address resolves anywhere ⇒ the company falls back to display-only people.
const noEmailDeps: ResolvePoolDeps = {
  scrape: async () => emptyScrape,
  resolve: async (): Promise<ResolvedEmail> => ({ email: null, emailStatus: 'none', likelyEmailPattern: null, resolver: 'none' }),
};
// The recipient-fit gate, here accepting everyone (it is exercised for drops in
// contacts.test.ts; here we only need it ON so the display-only path is gated).
const matchAll = async (): Promise<ContactVerification> => ({ verdict: 'match', confidence: 0.9, reason: 'ok', research: [] });

async function surfaced(c: QualityCase): Promise<{ id: string; mode: string; catchAll: ContactRow[]; display: ContactRow[] }> {
  const icp = icpFor(c);
  const target = { _id: 't1', companyName: c.companyName } as TargetDoc;
  const mission = { _id: 'm1', mode: c.mode } as MissionDoc;
  const ranked = rankCandidates(c.serp.map(serpResultToSuggestion), { icp, sizeTier: c.sizeTier, target, mission, profile: null }).rows;
  // Catch-all segment: keep 1, gate on.
  const catchAll = await resolvePoolWithBudget(ranked, 'co.example', 't1', 1, { ...catchAllDeps, verify: matchAll });
  // Display-only segment: resolver finds no address, fill from the bench (fit-gated).
  const noEmail = await resolvePoolWithBudget(ranked, 'co.example', 't1', 1, { ...noEmailDeps, verify: matchAll });
  const display = await fillWithVettedDisplayOnly(noEmail.rows, ranked, 1, matchAll);
  return { id: c.id, mode: c.mode, catchAll: catchAll.rows, display };
}

describe('contact-coverage — we surface a contact, and it is the right one', () => {
  const results = CONTACT_QUALITY_CASES.map(surfaced);

  it('every company yields a contact on a catch-all domain (recall@company == 1.0)', async () => {
    const rs = await Promise.all(results);
    for (const r of rs) {
      assert.ok(r.catchAll.length >= 1, `${r.id}: catch-all domain came back empty`);
      assert.equal(r.catchAll[0].emailStatus, 'likely', `${r.id}: catch-all contact should be labelled likely`);
    }
  });

  it('every company yields a display-only contact when no email resolves (recall@company == 1.0)', async () => {
    const rs = await Promise.all(results);
    for (const r of rs) {
      assert.ok(r.display.length >= 1, `${r.id}: display-only fallback came back empty`);
      assert.equal(r.display[0].email, null, `${r.id}: display-only contact has no email`);
    }
  });

  it('the surfaced contact is a correct one for the mission (precision ≥ 0.90 on both paths)', async () => {
    const rs = await Promise.all(results);
    const right = (id: string) => new Set((CONTACT_QUALITY_CASES.find((c) => c.id === id)!.right).map(firstName));
    const hit = (rows: ContactRow[], id: string) => (rows.length > 0 && right(id).has(firstName(rows[0].name)) ? 1 : 0);
    const pCatch = rs.reduce((a, r) => a + hit(r.catchAll, r.id), 0) / rs.length;
    const pDisplay = rs.reduce((a, r) => a + hit(r.display, r.id), 0) / rs.length;
    // eslint-disable-next-line no-console
    console.log(`contact-coverage: catch-all precision=${pCatch.toFixed(3)} display-only precision=${pDisplay.toFixed(3)} (n=${rs.length})`);
    assert.ok(pCatch >= 0.9, `catch-all surfaced-precision ${pCatch.toFixed(3)} < 0.90 — recovery is smuggling in distractors`);
    assert.ok(pDisplay >= 0.9, `display-only surfaced-precision ${pDisplay.toFixed(3)} < 0.90 — recovery is smuggling in distractors`);
  });
});
