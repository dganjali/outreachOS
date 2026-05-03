import { useCallback, useEffect, useState } from 'react';
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

export function Inbox() {
  const { user } = useAuth();
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'unhandled' | 'all'>('unhandled');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentByReply, setSentByReply] = useState<Record<string, SentMessage | undefined>>({});

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

  async function classify(reply: Reply) {
    setError(null);
    setBusy(reply.id);
    try {
      const r = await agents.reply(reply.id);
      setReplies((rs) =>
        rs.map((x) =>
          x.id === reply.id
            ? {
                ...x,
                classification: r.classification.classification,
                urgency: r.classification.urgency as Reply['urgency'],
                key_points: r.classification.key_points,
                suggested_response: r.classification.suggested_response,
                recommended_action: r.classification.recommended_action,
              }
            : x
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Classification failed');
    } finally {
      setBusy(null);
    }
  }

  async function markHandled(reply: Reply, handled: boolean) {
    await supabase.from('replies').update({ handled }).eq('id', reply.id);
    setReplies((rs) => rs.map((x) => (x.id === reply.id ? { ...x, handled } : x)));
  }

  return (
    <div>
      <header className="dashboard-header">
        <div>
          <h1 style={{ margin: 0 }}>Inbox</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.9375rem' }}>
            Replies detected from your sent outreach. Auto-refreshes via the Gmail polling cron.
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
        </div>
      </header>

      {error && <div className="banner-error">{error}</div>}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : replies.length === 0 ? (
        <div className="empty-card">
          <p>No replies yet. The polling worker checks Gmail every ~10 minutes for new replies on threads you've sent.</p>
        </div>
      ) : (
        <div className="reply-list">
          {replies.map((r) => {
            const sent = sentByReply[r.id];
            const cls = r.classification as ReplyClassification | null;
            return (
              <article key={r.id} className={`reply-card ${r.handled ? 'handled' : ''}`}>
                <header className="reply-card-head">
                  <div>
                    <strong>{r.from_email ?? 'unknown sender'}</strong>
                    {cls && <span className={`class-pill ${CLASS_COLOR[cls]}`}>{CLASS_LABEL[cls]}</span>}
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
                  {!cls && (
                    <button
                      type="button"
                      className="btn-secondary tiny"
                      disabled={busy === r.id}
                      onClick={() => classify(r)}
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
