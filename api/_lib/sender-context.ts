// Helpers to keep targeting/contacts from surfacing the sender's own orgs,
// school projects, or the sender as a contact.

import type { ProfileDoc } from '../../shared/schemas';

/** Lowercased names/orgs/projects the sender is affiliated with — never target these. */
export function senderExclusions(profile: ProfileDoc | null): string[] {
  const out = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.trim().toLowerCase();
    if (t && t.length > 1) out.add(t);
  };

  add(profile?.name);
  add(profile?.organization);

  const headline = String((profile?.linkedinData as { headline?: string } | null)?.headline ?? '');
  const roleOnly = new Set(['student', 'founder', 'ceo', 'cto', 'engineer', 'intern']);
  for (const part of headline.split(/\s[-–—@|]\s|\s+at\s+/i)) {
    const cleaned = part.replace(/^(student|founder|ceo|cto|engineer|intern)\s+/i, '').trim();
    if (!cleaned || roleOnly.has(cleaned.toLowerCase())) continue;
    add(cleaned);
  }

  const proof = profile?.proofPoints ?? '';
  for (const m of proof.matchAll(
    /(?:associated with|building|founder of|co-?founder of|project[s]?:?)\s+([A-Za-z0-9][A-Za-z0-9 &.'-]{1,48})/gi
  )) {
    add(m[1].replace(/\s+(project|startup|company)$/i, '').trim());
  }

  return [...out];
}

export function isExcludedName(name: string, exclusions: string[]): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  for (const ex of exclusions) {
    if (n === ex) return true;
    // Avoid matching tiny tokens inside unrelated names.
    if (ex.length < 4) continue;
    if (n.includes(ex) || ex.includes(n)) return true;
  }
  return false;
}

export function isValidDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d);
}

export function normalizeDomain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  try {
    const raw = domain.trim();
    const host = (raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`)).hostname;
    const d = host.replace(/^www\./, '').toLowerCase();
    return isValidDomain(d) ? d : null;
  } catch {
    const d = domain.trim().toLowerCase().replace(/^www\./, '');
    return isValidDomain(d) ? d : null;
  }
}

export function senderContextLines(profile: ProfileDoc | null): string[] {
  const lines: string[] = [];
  if (profile?.name) {
    lines.push(
      `Sender: ${profile.name}${profile.role ? `, ${profile.role}` : ''}${
        profile.organization ? ` at ${profile.organization}` : ''
      }`
    );
  }
  const exclusions = senderExclusions(profile);
  if (exclusions.length) {
    lines.push(
      `NEVER target or contact anyone at these sender-affiliated names/orgs/projects: ${exclusions.join(', ')}`
    );
  }
  if (profile?.proofPoints) lines.push(`Sender credibility: ${profile.proofPoints}`);
  return lines;
}
