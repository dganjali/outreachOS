import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Inbox as InboxIcon, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { agents, gmail } from '../lib/api';
import type { Reply, ReplyClassification, SentMessage } from '../types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const PILL_TONE: Record<string, string> = {
  green: 'border-primary/30 bg-primary/10 text-primary',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  blue: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
  red: 'border-destructive/40 bg-destructive/10 text-destructive',
  gray: 'border-border bg-secondary text-muted-foreground',
};

function pill(tone: string) {
  return cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', PILL_TONE[tone] ?? PILL_TONE.gray);
}

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
    const { error } = await supabase.from('replies').update({ handled }).eq('id', reply.id);
    if (error) {
      toast.error(`Could not update reply: ${error.message}`);
      return;
    }
    setReplies((rs) => rs.map((x) => (x.id === reply.id ? { ...x, handled } : x)));
  }

  const unclassifiedCount = replies.filter((r) => !r.classification).length;

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inbox</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Recorded replies, classified with a suggested response.{' '}
            {classifyingIds.size > 0 && unclassifiedCount > 0 ? 'Classifying…' : ''}
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1">
          {(['unhandled', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors',
                filter === f ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
            onClick={() => load()}
            title="Reload"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-28 w-full rounded-lg" />
        </div>
      ) : replies.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <InboxIcon className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">No replies recorded</h3>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            Replies land directly in your Gmail inbox - OutreachOS sends from your account and
            never reads your mail. When someone writes back, open their contact on the mission
            page and hit &ldquo;Mark replied&rdquo; so their scheduled follow-ups stop.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {replies.map((r) => {
            const sent = sentByReply[r.id];
            const cls = r.classification as ReplyClassification | null;
            const isClassifying = classifyingIds.has(r.id);
            return (
              <article
                key={r.id}
                className={cn('panel p-5 transition-opacity', r.handled && 'opacity-60')}
              >
                <header className="flex items-start justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-sm font-semibold text-foreground">{r.from_email ?? 'unknown sender'}</strong>
                    {cls && <span className={pill(CLASS_COLOR[cls])}>{CLASS_LABEL[cls]}</span>}
                    {!cls && isClassifying && (
                      <span className={pill('gray')}>
                        <Loader2 className="h-3 w-3 animate-spin" /> triaging…
                      </span>
                    )}
                    {r.urgency === 'high' && <span className={pill('red')}>urgent</span>}
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {r.received_at ? timeAgo(r.received_at) : '-'}
                  </span>
                </header>

                {r.subject && <div className="mt-2 text-sm font-medium text-foreground">{r.subject}</div>}
                <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {r.body || r.snippet}
                </div>

                {sent && (
                  <details className="mt-3 rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Original outreach</summary>
                    <div className="mt-2 text-sm font-medium text-foreground">{sent.subject}</div>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">{sent.body}</pre>
                  </details>
                )}

                {r.recommended_action && (
                  <div className="mt-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm text-muted-foreground">
                    <strong className="font-medium text-foreground">Recommended:</strong> {r.recommended_action}
                  </div>
                )}

                {r.suggested_response && (
                  <SuggestedReply
                    reply={r}
                    onSent={() => setReplies((rs) => rs.map((x) => (x.id === r.id ? { ...x, handled: true } : x)))}
                  />
                )}

                <div className="mt-4 flex items-center gap-2">
                  {!cls && !isClassifying && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy === r.id}
                      onClick={() => classifyManually(r)}
                    >
                      {busy === r.id ? 'Classifying…' : 'Classify with AI'}
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" onClick={() => markHandled(r, !r.handled)}>
                    {r.handled ? 'Mark unhandled' : 'Mark handled'}
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SuggestedReply({ reply, onSent }: { reply: Reply; onSent: () => void }) {
  const [subject, setSubject] = useState(reply.suggested_response?.subject ?? '');
  const [body, setBody] = useState(reply.suggested_response?.body ?? '');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setErr(null);
    try {
      await gmail.reply(reply.id, subject, body);
      setSent(true);
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  function copy() {
    navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (sent) {
    return (
      <div className="mt-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary">
        ✓ Reply sent.
      </div>
    );
  }

  const notConnected = err && /gmail_not_connected/i.test(err);

  return (
    <div className="mt-4 flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Suggested reply, edit &amp; send
      </div>
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="bg-background/40" />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} className="bg-background/40" />
      {err && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive [&_a]:font-medium [&_a]:text-primary">
          {notConnected ? (
            <>Connect Gmail in <Link to="/settings">Settings</Link> to send replies.</>
          ) : (
            err
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          className="btn-glow border-0 font-semibold text-primary-foreground"
          onClick={send}
          disabled={sending || !body.trim()}
        >
          {sending ? 'Sending…' : 'Send reply'}
        </Button>
        <button
          type="button"
          className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={copy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
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
