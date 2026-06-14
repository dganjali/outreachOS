import type { Profile } from '../types';

export const SNAPSHOT_FIELDS = [
  'name',
  'role',
  'organization',
  'bio',
  'resume_url',
  'linkedin_url',
  'website',
  'portfolio_links',
  'proof_points',
  'achievements',
  'metrics',
  'example_emails',
  'writing_tone',
] as const;

export type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];

export type ProfileSnapshot = {
  [K in SnapshotField]: K extends 'portfolio_links' ? string[] : string;
};

export const EMPTY_SNAPSHOT: ProfileSnapshot = {
  name: '',
  role: '',
  organization: '',
  bio: '',
  resume_url: '',
  linkedin_url: '',
  website: '',
  portfolio_links: [],
  proof_points: '',
  achievements: '',
  metrics: '',
  example_emails: '',
  writing_tone: '',
};

export function snapshotFromProfile(p: Profile | null): ProfileSnapshot {
  if (!p) return { ...EMPTY_SNAPSHOT };
  return {
    name: p.name ?? '',
    role: p.role ?? '',
    organization: p.organization ?? '',
    bio: p.bio ?? '',
    resume_url: p.resume_url ?? '',
    linkedin_url: p.linkedin_url ?? '',
    website: p.website ?? '',
    portfolio_links: p.portfolio_links ?? [],
    proof_points: p.proof_points ?? '',
    achievements: p.achievements ?? '',
    metrics: p.metrics ?? '',
    example_emails: p.example_emails ?? '',
    writing_tone: p.writing_tone ?? '',
  };
}

export function normalizeSnapshot(raw: unknown): ProfileSnapshot {
  const out: ProfileSnapshot = { ...EMPTY_SNAPSHOT };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const f of SNAPSHOT_FIELDS) {
    const v = obj[f];
    if (f === 'portfolio_links') {
      out.portfolio_links = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } else {
      (out as Record<string, unknown>)[f] = typeof v === 'string' ? v : '';
    }
  }
  return out;
}

export type SnapshotDiff = {
  field: SnapshotField;
  before: string | string[];
  after: string | string[];
};

export function diffSnapshots(before: ProfileSnapshot, after: ProfileSnapshot): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  for (const f of SNAPSHOT_FIELDS) {
    if (f === 'portfolio_links') {
      const a = before.portfolio_links;
      const b = after.portfolio_links;
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
        diffs.push({ field: f, before: a, after: b });
      }
    } else {
      const a = before[f];
      const b = after[f];
      if (a !== b) diffs.push({ field: f, before: a, after: b });
    }
  }
  return diffs;
}

export const SNAPSHOT_COALESCE_MS = 10 * 60 * 1000;

/**
 * Decide whether a save warrants a new profile_versions row.
 * Rule: snapshot if nothing exists yet, if the last snapshot is >10 min old,
 * or if this save came from a non-manual source (enrich/restore - always preserve those).
 */
export function shouldSnapshot(opts: {
  lastSnapshotAt: string | null;
  source: 'manual' | 'enrich' | 'coach' | 'import' | 'restore';
  diffs: SnapshotDiff[];
}): boolean {
  if (opts.diffs.length === 0) return false;
  if (opts.source !== 'manual') return true;
  if (!opts.lastSnapshotAt) return true;
  const age = Date.now() - new Date(opts.lastSnapshotAt).getTime();
  return age > SNAPSHOT_COALESCE_MS;
}

const FIELD_LABELS: Record<SnapshotField, string> = {
  name: 'Name',
  role: 'Role',
  organization: 'Organization',
  bio: 'Bio',
  resume_url: 'Resume URL',
  linkedin_url: 'LinkedIn',
  website: 'Website',
  portfolio_links: 'Portfolio links',
  proof_points: 'Proof points',
  achievements: 'Achievements',
  metrics: 'Metrics',
  example_emails: 'Example emails',
  writing_tone: 'Tone',
};

export function fieldLabel(f: SnapshotField): string {
  return FIELD_LABELS[f];
}
