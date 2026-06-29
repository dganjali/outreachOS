// The global "already contacted" layer.
//
//  • contact_ledger  — per-account, permanent: one row per person this user has
//    ever sent/queued an INITIAL email to, across ALL missions. Discovery reads
//    it so a person enters the account's outreach exactly once, ever.
//  • contact_heat    — platform-wide, ANONYMIZED: a salted-hash tally of how
//    often each contact has been emailed across every account, so ranking can
//    spread load instead of every account hammering the same popular profiles.
//    Hashes are not reversible to a person and carry no userId. Off by default
//    (CONTACT_HEAT_ENABLED + CONTACT_HEAT_SALT).
//
// Both are written from a single place — recordContacted — at the moment an
// initial touch is committed (queued or sent). See autopilot-tick.ts / gmail/send.ts.

import { createHash } from 'node:crypto';
import { adminDb, newId, type UserScope } from './db';
import { env } from './env';
import type { ContactLedgerDoc, ContactHeatDoc } from '../../shared/schemas';

/** Lower-cased email, or null. Mirrors contacts.ts dedup keying. */
export function emailKeyOf(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e || null;
}

/** `${linkedinUrl}|${name}` lower-cased — identical to contacts.ts contactKey so
 *  the ledger and the in-mission dedup share one identity shape. */
export function identityKeyOf(linkedinUrl: string | null | undefined, name: string): string {
  return `${(linkedinUrl ?? '').trim().toLowerCase()}|${(name ?? '').trim().toLowerCase()}`;
}

export interface ContactedKeys {
  emailKeys: Set<string>;
  identityKeys: Set<string>;
}

/** Load this account's full contacted-ledger as dedup sets (projection-only). */
export async function loadContactedKeys(scope: UserScope): Promise<ContactedKeys> {
  const emailKeys = new Set<string>();
  const identityKeys = new Set<string>();
  try {
    const rows = await scope
      .collection<ContactLedgerDoc>('contact_ledger')
      .find({}, { projection: { emailKey: 1, identityKey: 1 } });
    for (const r of rows) {
      if (r.emailKey) emailKeys.add(r.emailKey);
      if (r.identityKey) identityKeys.add(r.identityKey);
    }
  } catch (err) {
    console.warn('contact_ledger_load_failed', err);
  }
  return { emailKeys, identityKeys };
}

function isDuplicateKey(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

export interface RecordContactedArgs {
  email: string | null;
  linkedinUrl: string | null;
  name: string;
  missionId: string;
}

/**
 * Record that this account has committed an INITIAL touch to a person: write the
 * permanent ledger row (idempotent) and bump the anonymized cross-account heat.
 * Best-effort — never throws into the send path.
 */
export async function recordContacted(scope: UserScope, args: RecordContactedArgs): Promise<void> {
  const emailKey = emailKeyOf(args.email);
  const identityKey = identityKeyOf(args.linkedinUrl, args.name);

  try {
    const existing = await scope
      .collection<ContactLedgerDoc>('contact_ledger')
      .findOne({ identityKey } as never);
    if (!existing) {
      await scope.collection<ContactLedgerDoc>('contact_ledger').insertOne({
        _id: newId(),
        emailKey,
        identityKey,
        firstContactedAt: new Date(),
        missionId: args.missionId,
      } as never);
    }
  } catch (err) {
    // Unique-index collision under a race ⇒ already recorded; anything else logs.
    if (!isDuplicateKey(err)) console.warn('contact_ledger_record_failed', err);
  }

  await bumpHeat(identityKey);
}

// ---------------------------------------------------------------------------
// Cross-account heat (anonymized). Identity → salted SHA-256 → tally _id.
// ---------------------------------------------------------------------------

export function heatEnabled(): boolean {
  return env.CONTACT_HEAT_ENABLED() && !!env.CONTACT_HEAT_SALT();
}

function heatHash(identityKey: string): string {
  return createHash('sha256').update(`${env.CONTACT_HEAT_SALT()}:${identityKey}`).digest('hex');
}

async function bumpHeat(identityKey: string): Promise<void> {
  if (!heatEnabled() || !identityKey) return;
  try {
    const db = await adminDb();
    await db.collection<ContactHeatDoc>('contact_heat').updateOne(
      { _id: heatHash(identityKey) },
      { $inc: { sends: 1 }, $set: { lastContactedAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.warn('contact_heat_bump_failed', err);
  }
}

/** How heavily each identity has been emailed platform-wide. Empty when heat is
 *  off. Keyed by the SAME identityKey the caller passes in (not the hash). */
export async function loadHeatFor(
  identityKeys: string[]
): Promise<Map<string, { sends: number; lastContactedAt: Date }>> {
  const out = new Map<string, { sends: number; lastContactedAt: Date }>();
  if (!heatEnabled() || identityKeys.length === 0) return out;
  try {
    const db = await adminDb();
    const hashToKey = new Map(identityKeys.map((k) => [heatHash(k), k]));
    const docs = await db
      .collection<ContactHeatDoc>('contact_heat')
      .find({ _id: { $in: [...hashToKey.keys()] } })
      .toArray();
    for (const d of docs) {
      const k = hashToKey.get(d._id);
      if (k) out.set(k, { sends: d.sends, lastContactedAt: d.lastContactedAt });
    }
  } catch (err) {
    console.warn('contact_heat_load_failed', err);
  }
  return out;
}

/**
 * Soft multiplicative down-rank for a contact given its platform-wide heat. Never
 * eliminates (floor 0.5); decays back toward 1.0 as the last contact ages out
 * (~90-day half-life) so a profile cools off and becomes reachable again.
 */
export function heatPenalty(heat: { sends: number; lastContactedAt: Date } | undefined, now: Date = new Date()): number {
  if (!heat || heat.sends <= 0) return 1;
  const ageDays = Math.max(0, (now.getTime() - new Date(heat.lastContactedAt).getTime()) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / 90); // 1 fresh → ~0 after several months
  // log1p(sends) keeps it gentle (diminishing) and the 0.15 coefficient stops a
  // couple of sends from saturating it, so the penalty stays discriminative
  // across the realistic range. Floor 0.4 keeps it a down-rank, never a block.
  const pressure = 0.15 * Math.log1p(heat.sends) * recency;
  return Math.max(0.4, 1 / (1 + pressure));
}
