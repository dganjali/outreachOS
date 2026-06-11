// Stylized product mockups for the landing page, framed in browser chrome.
// Pure markup (no real screenshots) representing the actual app views:
// the mission pipeline, the draft editor, and the reply inbox. Dark theme.

export function BrowserFrame({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_30px_80px_-40px_rgba(0,0,0,0.8)]">
      <div className="flex items-center gap-3 border-b border-border/70 bg-secondary/40 px-3.5 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <i className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <i className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <i className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="truncate rounded-md bg-background/60 px-2.5 py-1 font-mono text-[11px] text-muted-foreground">
          {url}
        </span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

const TARGETS = [
  { name: 'Resend', why: 'Series B · hiring DevRel', score: 95 },
  { name: 'Linear', why: 'Launched Insights · community push', score: 91 },
  { name: 'Supabase', why: 'New AI features · dev events', score: 88 },
  { name: 'Clerk', why: 'Series B · expanding partnerships', score: 84 },
];

export function PipelineMock() {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs text-muted-foreground">q1-sponsorship</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> running
        </span>
      </div>
      <ul className="flex flex-col gap-px overflow-hidden rounded-lg border border-border/70 bg-background/40">
        {TARGETS.map((t) => (
          <li key={t.name} className="flex items-center gap-3 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-medium text-foreground">{t.name}</span>
              <span className="truncate text-xs text-muted-foreground">{t.why}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary">
                <span className="block h-full rounded-full bg-primary" style={{ width: `${t.score}%` }} />
              </span>
              <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{t.score}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DraftMock() {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex gap-2 border-b border-border/60 pb-2 text-muted-foreground">
        <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-muted-foreground/70">To</span>
        <span className="text-foreground">jess@resend.com</span>
      </div>
      <div className="flex gap-2 border-b border-border/60 pb-2 text-muted-foreground">
        <span className="w-12 shrink-0 text-xs uppercase tracking-wide text-muted-foreground/70">Subj</span>
        <span className="text-foreground">Sponsoring our 2026 developer conference?</span>
      </div>
      <div className="flex flex-col gap-2 pt-1 leading-relaxed text-muted-foreground">
        <p>Hey Jess,</p>
        <p>
          Saw Resend <Mark>closed Series B this March</Mark> and <Mark>is hiring its first
          developer-marketing lead</Mark>. That same week, the team <Mark>shipped Vue support</Mark>,
          the exact framework crowd we host.
        </p>
        <p>Our conference drew 1,400+ engineers last year. Worth 15 minutes next week?</p>
      </div>
      <div className="mt-1 flex items-center justify-between border-t border-border/60 pt-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          3 sources
        </span>
        <span className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">Send</span>
      </div>
    </div>
  );
}

function Mark({ children }: { children: React.ReactNode }) {
  return (
    <mark className="rounded bg-primary/15 px-1 text-foreground decoration-clone">{children}</mark>
  );
}

const REPLIES = [
  { from: 'Jess at Resend', snippet: 'Interesting, can you send tiers?', tag: 'Interested', tone: 'ok' as const },
  { from: 'Marco at Linear', snippet: 'Not this quarter, ping me in Q3.', tag: 'Not now', tone: 'warn' as const },
  { from: 'Dana at Clerk', snippet: 'I am not the right person for this.', tag: 'Wrong person', tone: 'muted' as const },
];

const TAG_TONE: Record<'ok' | 'warn' | 'muted', string> = {
  ok: 'border-primary/30 bg-primary/10 text-primary',
  warn: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  muted: 'border-border bg-secondary text-muted-foreground',
};

export function InboxMock() {
  return (
    <div className="flex flex-col gap-2">
      {REPLIES.map((r) => (
        <div
          key={r.from}
          className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/40 px-3 py-2.5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium text-foreground">{r.from}</span>
            <span className="truncate text-xs text-muted-foreground">{r.snippet}</span>
          </div>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TAG_TONE[r.tone]}`}>
            {r.tag}
          </span>
        </div>
      ))}
    </div>
  );
}
