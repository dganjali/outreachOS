import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeAndClean, personKey, buildAlready, toTargetRow, isLikelyPersonName } from './people';
import type { ProfileDoc, TargetDoc } from '../../shared/schemas';

// A discovered person as the LLM hands them back (shape of OpenPerson).
function person(over: Partial<{
  name: string;
  role: string;
  company: string;
  linkedin_url: string | null;
  location: string | null;
  headline: string | null;
  confidence: number;
  reasoning: string;
}> = {}) {
  return {
    name: 'Ada Investor',
    role: 'General Partner',
    company: 'Acme Ventures',
    linkedin_url: 'https://linkedin.com/in/adainvestor',
    location: 'Toronto, CA',
    headline: 'Backing dev-tools founders',
    confidence: 0.8,
    reasoning: 'matches',
    ...over,
  };
}

describe('personKey - stable identity for a discovered person', () => {
  it('keys off the LinkedIn profile, ignoring name/company noise', () => {
    const a = personKey({ name: 'Ada I.', company: 'Acme', linkedin_url: 'https://www.linkedin.com/in/adainvestor/' });
    const b = personKey({ name: 'Ada Investor', company: 'Acme Ventures', linkedin_url: 'https://linkedin.com/in/adainvestor' });
    assert.equal(a, b);
  });

  it('falls back to name+company when there is no LinkedIn URL', () => {
    const a = personKey({ name: 'Ada Investor', company: 'Acme Ventures', linkedin_url: null });
    const b = personKey({ name: 'ada investor', company: 'ACME VENTURES', linkedin_url: null });
    assert.equal(a, b);
    assert.match(a, /^nc:/);
  });
});

describe('dedupeAndClean', () => {
  it('dedupes the same person discovered twice', () => {
    const out = dedupeAndClean([person(), person({ name: 'Ada (dup)' })], null, new Set());
    assert.equal(out.length, 1);
  });

  it('drops people with no discernible company (required downstream)', () => {
    const out = dedupeAndClean([person({ company: '' })], null, new Set());
    assert.equal(out.length, 0);
  });

  it('excludes sender-affiliated names and orgs', () => {
    const profile = { name: 'Me Myself', organization: 'Acme Ventures' } as ProfileDoc;
    const out = dedupeAndClean([person()], profile, new Set());
    assert.equal(out.length, 0, 'a person at the sender’s own org is dropped');
  });

  it('skips people already surfaced for the mission (re-run freshness)', () => {
    const already = new Set([personKey({ name: 'Ada Investor', company: 'Acme Ventures', linkedin_url: 'https://linkedin.com/in/adainvestor' })]);
    const out = dedupeAndClean([person()], null, already);
    assert.equal(out.length, 0);
  });

  it('drops firms/funds that the model returned as a "person"', () => {
    const firms = [
      person({ name: 'Fin Capital', company: 'Fin Capital', linkedin_url: null }),
      person({ name: 'VU Venture Partners', company: 'VU Venture Partners', linkedin_url: null }),
      person({ name: 'Wing Venture Capital', company: 'Wing Venture Capital', linkedin_url: null }),
      person({ name: '2080 Ventures Investor Relations', company: '2080 Ventures Investor Relations', linkedin_url: null }),
    ];
    const out = dedupeAndClean(firms, null, new Set());
    assert.equal(out.length, 0, 'no firm names survive as people');
  });

  it('keeps a real individual even when the firm name is fund-y', () => {
    const out = dedupeAndClean(
      [person({ name: 'W. David Stern', role: 'Managing Partner', company: 'Venture Group Capital', linkedin_url: null })],
      null,
      new Set(),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'W. David Stern');
  });
});

describe('isLikelyPersonName - firm vs individual', () => {
  it('rejects the firm-as-person tells', () => {
    assert.equal(isLikelyPersonName('Fin Capital', 'Fin Capital'), false); // name === company
    assert.equal(isLikelyPersonName('VU Venture Partners', 'VU Venture Partners'), false);
    assert.equal(isLikelyPersonName('2080 Ventures', 'Some Fund'), false); // digit + org token
    assert.equal(isLikelyPersonName('Acme Holdings LLC', 'Acme'), false); // org tokens
  });
  it('accepts real individuals', () => {
    assert.equal(isLikelyPersonName('W. David Stern', 'Venture Group Capital'), true);
    assert.equal(isLikelyPersonName('Ada Investor', 'Acme Ventures'), true);
  });
});

describe('buildAlready - only person-targets count toward freshness', () => {
  it('keys person-targets and ignores plain company targets', () => {
    const personTarget = {
      companyName: 'Acme Ventures',
      seedContact: { name: 'Ada Investor', role: 'GP', linkedinUrl: 'https://linkedin.com/in/adainvestor', location: null, headline: null, confidence: 0.8 },
    } as TargetDoc;
    const companyTarget = { companyName: 'Globex', seedContact: null } as TargetDoc;
    const already = buildAlready([personTarget, companyTarget]);
    assert.equal(already.size, 1);
    assert.ok(already.has(personKey({ name: 'Ada Investor', company: 'Acme Ventures', linkedin_url: 'https://linkedin.com/in/adainvestor' })));
  });
});

describe('toTargetRow - person → pipeline target', () => {
  const domains = new Map<string, string>([['Acme Ventures', 'acmevc.com']]);
  const row = toTargetRow(person(), 0.82, domains, 'm1');

  it('carries the company as the target, resolving its domain', () => {
    assert.equal(row.companyName, 'Acme Ventures');
    assert.equal(row.domain, 'acmevc.com');
    assert.equal(row.missionId, 'm1');
  });

  it('seeds the discovered person so the contacts agent resolves THEM', () => {
    assert.equal(row.seedContact?.name, 'Ada Investor');
    assert.equal(row.seedContact?.role, 'General Partner');
    assert.equal(row.status, 'suggested');
    assert.equal(row.signalType, 'person');
  });

  it('scales the match score to the 0-100 target scale', () => {
    assert.equal(row.score, 82);
  });

  it('leaves domain null when the company could not be resolved', () => {
    const r = toTargetRow(person({ company: 'Mystery Fund' }), 0.5, domains, 'm1');
    assert.equal(r.domain, null);
  });
});
