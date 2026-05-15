import { useEffect, useRef, useState } from 'react';
import { agents, type CoachField } from '../../lib/api';

const FIELD_LABEL: Record<CoachField, string> = {
  bio: 'Bio',
  proof_points: 'Proof points',
  achievements: 'Achievements',
  metrics: 'Metrics',
  writing_tone: 'Tone',
  example_emails: 'Example emails',
};

interface Suggestion {
  title: string;
  rewrite: string;
  why: string;
}

interface CoachDrawerProps {
  open: boolean;
  field: CoachField | null;
  currentValue: string;
  onClose: () => void;
  onApply: (field: CoachField, value: string) => void;
}

export function CoachDrawer({ open, field, currentValue, onClose, onApply }: CoachDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [gaps, setGaps] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<{ sent_count: number; reply_count: number; reply_rate: number } | null>(null);
  const fetchKeyRef = useRef(0);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  async function run(activeField: CoachField, value: string) {
    fetchKeyRef.current += 1;
    const key = fetchKeyRef.current;
    setLoading(true);
    setError(null);
    setSuggestions(null);
    setGaps([]);
    setOutcomes(null);
    try {
      const r = await agents.coach(activeField, value);
      if (key !== fetchKeyRef.current) return;
      setSuggestions(r.suggestions);
      setGaps(r.gaps);
      setOutcomes(r.outcomes);
    } catch (err) {
      if (key !== fetchKeyRef.current) return;
      setError(err instanceof Error ? err.message : 'Coach failed');
    } finally {
      if (key === fetchKeyRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (open && field) {
      void run(field, currentValue);
      // Focus the close button so escape works immediately and screen-readers anchor here.
      requestAnimationFrame(() => closeBtnRef.current?.focus());
    }
    // Intentionally omit currentValue: we only refetch when the drawer opens or the
    // target field changes, not on every keystroke in the workshop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, field]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !field) return null;

  return (
    <>
      <div className="coach-overlay" onClick={onClose} aria-hidden />
      <aside
        className="coach-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Coach: ${FIELD_LABEL[field]}`}
      >
        <header className="coach-head">
          <div>
            <span className="coach-eyebrow">Coach</span>
            <h2 className="coach-title">{FIELD_LABEL[field]}</h2>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="coach-close"
            onClick={onClose}
            aria-label="Close coach"
          >
            ×
          </button>
        </header>

        <div className="coach-body">
          {outcomes && outcomes.sent_count > 0 && (
            <div className="coach-outcomes" role="status">
              <span>
                <strong>{outcomes.sent_count}</strong> sent
              </span>
              <span className="coach-outcomes-sep">·</span>
              <span>
                <strong>{outcomes.reply_count}</strong>{' '}
                {outcomes.reply_count === 1 ? 'reply' : 'replies'}{' '}
                <span className="coach-outcomes-rate">({outcomes.reply_rate}%)</span>
              </span>
              {outcomes.sent_count >= 5 && outcomes.reply_count === 0 && (
                <>
                  <span className="coach-outcomes-sep">·</span>
                  <span className="coach-outcomes-warn">underperforming</span>
                </>
              )}
            </div>
          )}

          <section className="coach-section">
            <div className="coach-section-head">
              <h3>Rewrites</h3>
              <button
                type="button"
                className="coach-refresh"
                onClick={() => run(field, currentValue)}
                disabled={loading}
              >
                {loading ? 'Thinking…' : 'Regenerate'}
              </button>
            </div>

            {loading && <SuggestionSkeleton />}

            {error && (
              <p role="alert" className="banner-error">
                {error}
              </p>
            )}

            {!loading && !error && suggestions && suggestions.length === 0 && (
              <p className="coach-empty">Coach couldn't produce rewrites for this field.</p>
            )}

            {!loading && !error && suggestions && suggestions.length > 0 && (
              <ul className="coach-suggestions">
                {suggestions.map((s, i) => (
                  <li key={i} className="coach-suggestion">
                    <div className="coach-suggestion-head">
                      <span className="coach-suggestion-title">{s.title}</span>
                      <button
                        type="button"
                        className="btn-primary coach-apply"
                        onClick={() => {
                          onApply(field, s.rewrite);
                        }}
                      >
                        Use this
                      </button>
                    </div>
                    <p className="coach-suggestion-rewrite">{s.rewrite}</p>
                    {s.why && <p className="coach-suggestion-why">{s.why}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!loading && !error && gaps.length > 0 && (
            <section className="coach-section">
              <div className="coach-section-head">
                <h3>What to add</h3>
              </div>
              <ul className="coach-gaps">
                {gaps.map((g, i) => (
                  <li key={i}>{g}</li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="coach-foot">
          <span className="coach-foot-meta">Counts against your daily agent-run cap.</span>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Done
          </button>
        </footer>
      </aside>
    </>
  );
}

function SuggestionSkeleton() {
  return (
    <ul className="coach-suggestions">
      {[0, 1, 2].map((i) => (
        <li key={i} className="coach-suggestion coach-suggestion-skel">
          <div className="coach-skel-line coach-skel-title" />
          <div className="coach-skel-line" />
          <div className="coach-skel-line" />
          <div className="coach-skel-line coach-skel-short" />
        </li>
      ))}
    </ul>
  );
}
