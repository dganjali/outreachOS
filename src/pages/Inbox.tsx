import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { agents } from '../lib/api';
import type { Reply, ReplyClassification, SentMessage } from '../types';

const CLASS_LABEL: Record<ReplyClassification, string> = {
  interested: 'Interested',
  not_now: 'Not now',
  wrong_person: 'Wrong person',
  referral: 'Referral',
  oof: 'Out of office',
  unsubscribe: 'Unsubscribe',
  question: 'Question',
  other: 'Other',
};

const CLASS_COLOR: Record<ReplyClassification, string> = {
  interested: 'green',
  not_now: 'amber',
  wrong_person: 'blue',
  referral: 'blue',
  oof: 'gray',
  unsubscribe: 'red',
  question: 'amber',
  other: 'gray',
};

// Cap how many replies we auto-classify per inbox open (keeps us well under the
// per-minute agent rate limit; the rest fall back to the manual button).
const AUTO_CLASSIFY_CAP = 6;

export function Inbox() {
  const { user } = useAuth();
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'unhandled' | 'all'>('unhandled');
  const [classifyingIds, setClassifyingIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentByReply, setSentByReply] = useState<Record<string, SentMessage | undefined>>({});
  const attemptedRef = useRef<Set<string>>(new Set());
  const autoRunningRef = useRef(false);

  const applyClassification = useCallback((replyId: string, c: ReplyClassification, full: {
    urgency?: Reply['urgency'];
    key_points?: string[];
    suggested_response?: { subject: string; body: string } | null;
    recommended_action?: string;
  }) => {
    setReplies((rs) =>
      rs.map((x) =>
        x.id === replyId
          ? {
              ...x,
              classification: c,
              urgency: (full.urgency ?? x.urgency) as Reply['urgency'],
              key_points: full.key_points ?? x.key_points,
              suggested_response: full.suggested_response ?? x.suggested_response,
              recommended_action: full.recommended_action ?? x.recommended_action,
            }
          : x
      )
    );
  }, []);

  const classifyOne = useCallback(
    async (replyId: string) => {
      const r = await agents.reply(replyId);
      applyClassification(replyId, r.classification.classification, {
        urgency: r.classification.urgency as Reply['urgency'],
        key_points: r.classification.key_points,
        suggested_response: r.classification.suggested_response,
        recommended_action: r.classification.recommended_action,
      });
    },
    [applyClassification]
  );

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    let q = supabase
      .from('replies')
      .select('*')
      .eq('user_id', user.id)
      .order('received_at', { ascending: false, nullsFirst: false })
      .limit(100);
    if (filter === 'unhandled') q = q.eq('handled', false);
    const { data } = await q;
    const list = (data ?? []) as Reply[];
    setReplies(list);

    const sentIds = list.map((r) => r.sent_message_id).filter((x): x is string => !!x);
    if (sentIds.length > 0) {
      const { data: sent } = await supabase.from('sent_messages').select('*').in('id', sentIds);
      const map: Record<string, SentMessage | undefined> = {};
      for (const s of (sent ?? []) as SentMessage[]) {
        const ridList = list.filter((r) => r.sent_message_id === s.id);
        for (const r of ridList) map[r.id] = s;
      }
      setSentByReply(map);
    }

    setLoading(false);
  }, [user?.id, filter]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-triage: classify any unclassified replies on load so the inbox is
  // useful immediately. Sequential + capped + rate-limit-aware; once-per-reply.
  useEffect(() => {
    if (loading || autoRunningRef.current) return;
    const pending = replies
      .filter((r) => !r.classification && !r.handled && !attemptedRef.current.has(r.id))
      .slice(0, AUTO_CLASSIFY_CAP);
    if (pending.length === 0) return;

    autoRunningRef.current = true;
    (async () => {
      try {
        for (const r of pending) {
          attemptedRef.current.add(r.id);
          setClassifyingIds((s) => new Set(s).add(r.id));
          try {
            await classifyOne(r.id);
          } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            if (/rate_limit/i.test(msg)) break; // stop; leave the rest for manual
          } finally {
            setClassifyingIds((s) => {
              const next = new Set(s);
              next.delete(r.id);
              return next;
            });
          }
        }
      } finally {
        autoRunningRef.current = false;
      }
    })();
  }, [replies, loading, classifyOne]);

  async function classifyManually(reply: Reply) {
    setError(null);
    setBusy(reply.id);
    setClassifyingIds((s) => new Set(s).add(reply.id));
    try {
      await classifyOne(reply.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Classification failed');
    } finally {
      setBusy(null);
      setClassifyingIds((s) => {
        const next = new Set(s);
        next.delete(reply.id);
        return next;
      });
    }
  }

  async function markHandled(reply: Reply, handled: boolean) {
    await supabase.from('replies').update({ handled }).eq('id', reply.id);
    setReplies((rs) => rs.map((x) => (x.id === reply.id ? { ...x, handled } : x)));
  }

  const unclassifiedCount = replies.filter((r) => !r.classification).length;

  return (
    <div>
      <header className="dashboard-header">
        <div>
          <h1 style={{ margin: 0 }}>Inbox</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Replies to your outreach, triaged automatically.{' '}
            {classifyingIds.size > 0 && unclassifiedCount > 0 ? 'Classifying new replies…' : ''}
          </p>
        </div>
        <div className="inbox-filter">
          <button
            type="button"
            className={filter === 'unhandled' ? 'pill-tab active' : 'pill-tab'}
            onClick={() => setFilter('unhandled')}
          >
            Unhandled
          </button>
          <button
            type="button"
            className={filter === 'all' ? 'pill-tab active' : 'pill-tab'}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button type="button" className="pill-tab" onClick={() => load()} title="Check for new replies">
            ↻
          </button>
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}

      {loading ? (
        <div className="skeleton-list">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : replies.length === 0 ? (
        <div className="empty-illo">
          <div className="empty-illo-graphic" aria-hidden>📥</div>
          <h3>No replies yet</h3>
          <p>
            We check Gmail every 15 minutes for replies on threads you've sent. When one lands, it shows
            up here — already classified, with a suggested response ready to go.
          </p>
        </div>
      ) : (
        <div className="reply-list">
          {replies.map((r) => {
            const sent = sentByReply[r.id];
            const cls = r.classification as ReplyClassification | null;
            const isClassifying = classifyingIds.has(r.id);
            return (
              <article key={r.id} className={`reply-card ${r.handled ? 'handled' : ''}`}>
                <header className="reply-card-head">
                  <div>
                    <strong>{r.from_email ?? 'unknown sender'}</strong>
                    {cls && <span className={`class-pill ${CLASS_COLOR[cls]}`}>{CLASS_LABEL[cls]}</span>}
                    {!cls && isClassifying && (
                      <span className="class-pill gray">
                        <span className="step-spin" style={{ marginRight: '0.3rem' }} />
                        triaging…
                      </span>
                    )}
                    {r.urgency === 'high' && <span className="class-pill red">urgent</span>}
                  </div>
                  <span className="reply-time">{r.received_at ? timeAgo(r.received_at) : '—'}</span>
                </header>

                {r.subject && <div className="reply-subject">{r.subject}</div>}
                <div className="reply-body">{r.body || r.snippet}</div>

                {sent && (
                  <details className="reply-original">
                    <summary>Original outreach</summary>
                    <div className="reply-subject">{sent.subject}</div>
                    <pre className="sequence-text">{sent.body}</pre>
                  </details>
                )}

                {r.recommended_action && (
                  <div className="reply-action"><strong>Recommended:</strong> {r.recommended_action}</div>
                )}

                {r.suggested_response && (
                  <div className="reply-suggested">
                    <div className="reply-suggested-label">Suggested reply</div>
                    <div className="reply-subject">{r.suggested_response.subject}</div>
                    <pre className="sequence-text">{r.suggested_response.body}</pre>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() =>
                        navigator.clipboard.writeText(`Subject: ${r.suggested_response!.subject}\n\n${r.suggested_response!.body}`)
                      }
                    >
                      Copy
                    </button>
                  </div>
                )}

                <div className="reply-actions">
                  {!cls && !isClassifying && (
                    <button
                      type="button"
                      className="btn-secondary tiny"
                      disabled={busy === r.id}
                      onClick={() => classifyManually(r)}
                    >
                      {busy === r.id ? 'Classifying…' : 'Classify with AI'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-secondary tiny"
                    onClick={() => markHandled(r, !r.handled)}
                  >
                    {r.handled ? 'Mark unhandled' : 'Mark handled'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
