import { useEffect, useMemo, useState } from 'react';
import type { ParsedResumeFields, ProfileAsset } from '../../types';
import type { ProfileSnapshot } from '../../lib/profileSnapshot';
import { fieldLabel, type SnapshotField } from '../../lib/profileSnapshot';

interface ParseResumeModalProps {
  open: boolean;
  asset: ProfileAsset | null;
  parsed: ParsedResumeFields | null;
  current: ProfileSnapshot;
  onClose: () => void;
  onAccept: (updates: Partial<ProfileSnapshot>, sourceAssetId: string) => Promise<void>;
}

const MERGEABLE_FIELDS: SnapshotField[] = [
  'bio',
  'proof_points',
  'achievements',
  'metrics',
  'writing_tone',
];

function pickParsedValue(parsed: ParsedResumeFields, field: SnapshotField): string {
  switch (field) {
    case 'bio':
      return parsed.bio ?? '';
    case 'proof_points':
      return parsed.proof_points ?? '';
    case 'achievements':
      return parsed.achievements ?? '';
    case 'metrics':
      return parsed.metrics ?? '';
    case 'writing_tone':
      return parsed.writing_tone ?? '';
    default:
      return '';
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n).trimEnd() + '…';
}

export function ParseResumeModal({
  open,
  asset,
  parsed,
  current,
  onClose,
  onAccept,
}: ParseResumeModalProps) {
  const proposals = useMemo(() => {
    if (!parsed) return [] as Array<{ field: SnapshotField; before: string; after: string }>;
    return MERGEABLE_FIELDS.map((f) => ({
      field: f,
      before: (current[f] as string) ?? '',
      after: pickParsedValue(parsed, f).trim(),
    })).filter((p) => p.after.length > 0 && p.after !== p.before);
  }, [parsed, current]);

  const [selected, setSelected] = useState<Record<SnapshotField, boolean>>(() =>
    Object.fromEntries(MERGEABLE_FIELDS.map((f) => [f, true])) as Record<SnapshotField, boolean>
  );
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (open) {
      // Default to "accept everything that's empty, leave existing-and-different unchecked
      // so users notice when the parser is overriding rather than filling".
      const next: Record<SnapshotField, boolean> = {} as Record<SnapshotField, boolean>;
      for (const p of proposals) {
        next[p.field] = p.before.trim().length === 0;
      }
      setSelected(next);
    }
  }, [open, proposals]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !asset || !parsed) return null;

  async function handleAccept() {
    if (!asset || !parsed) return;
    const updates: Partial<ProfileSnapshot> = {};
    for (const p of proposals) {
      if (selected[p.field]) {
        (updates as Record<string, unknown>)[p.field] = p.after;
      }
    }
    setAccepting(true);
    try {
      await onAccept(updates, asset.id);
    } finally {
      setAccepting(false);
    }
  }

  const checkedCount = proposals.filter((p) => selected[p.field]).length;

  return (
    <>
      <div className="parse-modal-overlay" onClick={onClose} aria-hidden />
      <div
        className="parse-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Review parsed resume"
      >
        <header className="parse-modal-head">
          <div>
            <span className="parse-modal-eyebrow">Parsed from resume</span>
            <h2 className="parse-modal-title">{asset.file_name}</h2>
            {parsed.headline && <p className="parse-modal-headline">{parsed.headline}</p>}
          </div>
          <button
            type="button"
            className="parse-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="parse-modal-body">
          {proposals.length === 0 ? (
            <p className="parse-modal-empty">
              Nothing new to merge. The parser didn't find fields that differ from your current
              profile. You can still keep the resume on file.
            </p>
          ) : (
            <>
              <p className="parse-modal-hint">
                Check the fields you want to merge. Conflicts (where you already have a value) are
                unchecked by default; review before overwriting.
              </p>
              <ul className="parse-modal-list">
                {proposals.map((p) => (
                  <li key={p.field} className="parse-modal-row">
                    <label className="parse-modal-row-head">
                      <input
                        type="checkbox"
                        checked={!!selected[p.field]}
                        onChange={(e) =>
                          setSelected((s) => ({ ...s, [p.field]: e.target.checked }))
                        }
                      />
                      <span className="parse-modal-field">{fieldLabel(p.field)}</span>
                      {p.before.trim().length > 0 && (
                        <span className="parse-modal-conflict">overwrite</span>
                      )}
                    </label>
                    <div className="parse-modal-diff">
                      <div className="parse-modal-diff-col parse-modal-diff-before">
                        <span className="parse-modal-diff-tag">current</span>
                        <span>{truncate(p.before || '(empty)', 240)}</span>
                      </div>
                      <div className="parse-modal-diff-col parse-modal-diff-after">
                        <span className="parse-modal-diff-tag">from resume</span>
                        <span>{truncate(p.after, 240)}</span>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {parsed.roles && parsed.roles.length > 0 && (
                <details className="parse-modal-roles">
                  <summary>{parsed.roles.length} role{parsed.roles.length === 1 ? '' : 's'} extracted (reference only)</summary>
                  <ul>
                    {parsed.roles.map((r, i) => (
                      <li key={i}>
                        <strong>{r.title}</strong>
                        {r.organization && <span> · {r.organization}</span>}
                        {(r.start || r.end) && (
                          <span className="parse-modal-roles-date">
                            {' '}
                            ({[r.start, r.end].filter(Boolean).join(' – ')})
                          </span>
                        )}
                        {r.summary && <div className="parse-modal-roles-summary">{r.summary}</div>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>

        <footer className="parse-modal-foot">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={accepting}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleAccept}
            disabled={accepting || checkedCount === 0}
          >
            {accepting
              ? 'Applying…'
              : checkedCount === 0
                ? 'Nothing selected'
                : `Apply ${checkedCount} field${checkedCount === 1 ? '' : 's'}`}
          </button>
        </footer>
      </div>
    </>
  );
}
