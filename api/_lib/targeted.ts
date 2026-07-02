// Cross-mission company dedup. The company-level counterpart to contact_ledger
// (api/_lib/contacted.ts): instead of a separate ledger we read the targets
// collection directly, since every company ever surfaced already persists there
// with its normalized `domain`.
//
// "Don't repeat companies across missions" means: once a company has been
// committed to in ANY mission (a target the user approved or actually contacted),
// discovery in other missions should not surface it again. Merely-suggested or
// rejected companies elsewhere are NOT excluded — they can resurface in a
// better-fit mission. Same-mission freshness (skip everything already surfaced in
// THIS mission) is handled by the agents themselves and is unaffected.

import type { UserScope } from './db';
import { normalizeDomain } from './sender-context';
import type { TargetDoc } from '../../shared/schemas';

// A target is "committed" once the user has acted on it. These statuses are the
// ones we refuse to repeat across missions.
const COMMITTED_STATUSES: TargetDoc['status'][] = ['approved', 'contacted'];

/**
 * Normalized domains of every company this account has approved or contacted,
 * across ALL missions. Projection-only + served by the covering
 * { userId, status, domain } index, so this stays a cheap index scan even for
 * accounts with thousands of targets. Best-effort: returns an empty set on error
 * so a lookup failure can never block discovery.
 */
export async function loadCommittedDomains(scope: UserScope): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const rows = await scope
      .collection<TargetDoc>('targets')
      .find({ status: { $in: COMMITTED_STATUSES } } as never, { projection: { domain: 1 } });
    for (const r of rows) {
      const d = normalizeDomain(r.domain);
      if (d) out.add(d);
    }
  } catch (err) {
    console.warn('committed_domains_load_failed', err);
  }
  return out;
}
