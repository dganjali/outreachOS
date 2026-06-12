// Stylized product mockups for the landing page, framed in browser chrome.
// Pure markup (no real screenshots) representing the actual app views:
// the mission pipeline, the draft editor, and the reply inbox. Dark theme.

import { useEffect, useRef, useState } from 'react';
import { LogoMark } from './Logo';
import {
  Search,
  PenSquare,
  Inbox as InboxIcon,
  Target as TargetIcon,
  FileText,
  GitBranch,
  Sparkles,
  ChevronDown,
  Check,
  X,
  ArrowUp,
  Paperclip,
} from 'lucide-react';

export function BrowserFrame({
  url,
  children,
  bodyClassName = 'p-4',
}: {
  url: string;
  children: React.ReactNode;
  bodyClassName?: string;
}) {
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
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero app mock — an interactive, prompt-driven demo. The viewer enters a
// mission (or one auto-plays) and a pre-scripted sequence runs: the agents
// research, targets stream in with fit scores, and a personalized email writes
// itself, citation by citation. Single green accent, neutral surfaces — no
// decorative colors. Used only in the hero.
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'thinking' | 'researching' | 'drafting' | 'done';

interface Lead {
  name: string;
  initials: string;
  why: string;
  score: number;
}

const LEADS: Lead[] = [
  { name: 'Resend', initials: 'RE', why: 'Series B · hiring DevRel', score: 95 },
  { name: 'Linear', initials: 'LI', why: 'Launched Insights · community push', score: 91 },
  { name: 'Supabase', initials: 'SU', why: 'New AI features · dev events', score: 88 },
  { name: 'Clerk', initials: 'CL', why: 'Series B · expanding partnerships', score: 84 },
  { name: 'Vercel', initials: 'VE', why: 'Shipped v0 · major launch', score: 82 },
];

// Top lead's email — « » marks the evidence-backed phrases.
const EMAIL = {
  to: 'jess@resend.com',
  subject: 'Sponsoring our 2026 developer conference?',
  sources: ['Series B — Mar 2026', 'Hiring first DevRel', 'Shipped Vue support'],
  body:
    'Hey Jess,\n\nSaw Resend «closed Series B this March» and is «hiring its first DevRel lead», the same week you «shipped Vue support». That is exactly the crowd we host.\n\nOur conference drew 1,400+ engineers last year. Worth 15 minutes next week?',
};
const EMAIL_PLAIN = EMAIL.body.replace(/[«»]/g, '');

const SUGGESTIONS = [
  'Find devtools to sponsor DevConf 2026',
  'Book meetings with seed founders hiring DevRel',
];
const DEFAULT_PROMPT = SUGGESTIONS[0];

function renderRich(text: string) {
  return text.split(/(«[^»]*»)/g).map((seg, i) =>
    seg.startsWith('«') ? <Mark key={i}>{seg.slice(1, -1)}</Mark> : <span key={i}>{seg}</span>
  );
}

function SideItem({ icon: Icon, label, active }: { icon: typeof InboxIcon; label: string; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${
        active ? 'bg-secondary/70 font-medium text-foreground' : 'text-muted-foreground'
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function FavItem({ label, active }: { label: string; active?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${
        active ? 'bg-secondary/70 font-medium text-foreground' : 'text-muted-foreground'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-primary' : 'border border-muted-foreground/40'}`} />
      <span className="truncate font-mono text-[11px]">{label}</span>
    </div>
  );
}

const PHASE_CHIP: Record<Phase, { label: string; live: boolean; solid?: boolean }> = {
  idle: { label: 'Idle', live: false },
  thinking: { label: 'Planning', live: true },
  researching: { label: 'Researching', live: true },
  drafting: { label: 'Drafting', live: true },
  done: { label: 'Ready', live: false, solid: true },
};

export function HeroAppMock() {
  const [prompt, setPrompt] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [revealed, setRevealed] = useState(0);
  const [typed, setTyped] = useState('');
  const [tab, setTab] = useState<'targets' | 'drafts' | 'replies'>('targets');
  const interacted = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function run(p: string) {
    clearTimers();
    setPrompt(p);
    setTyped('');
    setRevealed(0);
    setTab('targets');

    if (reduceMotion) {
      setPhase('done');
      setRevealed(LEADS.length);
      setTyped(EMAIL_PLAIN);
      return;
    }

    setPhase('thinking');
    after(650, () => setPhase('researching'));
    LEADS.forEach((_, i) => after(950 + i * 470, () => setRevealed(i + 1)));
    after(950 + LEADS.length * 470 + 250, () => setPhase('drafting'));
  }

  // Type the email out once the drafting phase begins.
  useEffect(() => {
    if (phase !== 'drafting') return;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTyped(EMAIL_PLAIN.slice(0, i));
      if (i >= EMAIL_PLAIN.length) {
        clearInterval(id);
        setPhase('done');
      }
    }, 15);
    return () => clearInterval(id);
  }, [phase]);

  // Auto-play the default mission shortly after mount, unless the viewer acts.
  useEffect(() => {
    if (reduceMotion) {
      run(DEFAULT_PROMPT);
      return clearTimers;
    }
    let i = 0;
    const startId = setTimeout(function typeChar() {
      if (interacted.current) return;
      i += 1;
      setPrompt(DEFAULT_PROMPT.slice(0, i));
      if (i < DEFAULT_PROMPT.length) {
        timers.current.push(setTimeout(typeChar, 42));
      } else {
        timers.current.push(setTimeout(() => !interacted.current && run(DEFAULT_PROMPT), 450));
      }
    }, 1100);
    timers.current.push(startId);
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = () => {
    interacted.current = true;
    clearTimers();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    stop();
    run(prompt.trim() || DEFAULT_PROMPT);
  };

  const running = phase === 'thinking' || phase === 'researching' || phase === 'drafting';
  const rows = phase === 'idle' || phase === 'thinking' ? 0 : phase === 'researching' ? revealed : LEADS.length;
  const draftsReady = phase === 'done' ? LEADS.length : phase === 'drafting' ? 1 : 0;
  const chip = PHASE_CHIP[phase];
  const sourcesUsed = Math.floor((typed.length / EMAIL_PLAIN.length) * (EMAIL.sources.length + 0.5));

  return (
    <div className="flex h-[468px] text-left">
      {/* Sidebar */}
      <aside className="hidden w-48 shrink-0 flex-col gap-4 border-r border-border/70 bg-background/40 p-3 sm:flex">
        <div className="flex items-center gap-2">
          <LogoMark size={18} variant="default" />
          <span className="text-[13px] font-semibold text-foreground">OutreachOS</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-secondary/40">
            <Search className="h-3 w-3" />
          </span>
          <span className="flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-secondary/40">
            <PenSquare className="h-3 w-3" />
          </span>
        </div>
        <nav className="flex flex-col gap-0.5">
          <SideItem icon={InboxIcon} label="Inbox" />
          <SideItem icon={TargetIcon} label="Missions" active />
          <SideItem icon={FileText} label="Drafts" />
          <SideItem icon={Sparkles} label="Pulse" />
        </nav>
        <div>
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
            Favorites
          </p>
          <div className="flex flex-col gap-0.5">
            <FavItem label="q1-sponsorship" active />
            <FavItem label="bd-partnerships" />
            <FavItem label="recruiting-q1" />
          </div>
        </div>
      </aside>

      {/* Main — prompt + streaming targets */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-2.5">
          <span className="truncate text-[13px] font-semibold text-foreground">New mission</span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              chip.solid
                ? 'border-primary/30 bg-primary/10 text-primary'
                : chip.live
                  ? 'border-border bg-secondary text-foreground'
                  : 'border-border bg-secondary text-muted-foreground'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${chip.live || chip.solid ? 'bg-primary' : 'bg-muted-foreground/50'} ${chip.live ? 'animate-pulse' : ''}`} />
            {chip.label}
          </span>
        </header>

        {/* Prompt bar */}
        <div className="border-b border-border/70 px-4 py-3">
          <form onSubmit={submit} className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2 focus-within:border-primary/50">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
            <input
              value={prompt}
              onChange={(e) => {
                stop();
                setPrompt(e.target.value);
              }}
              onFocus={stop}
              placeholder="Describe your mission…"
              className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/60"
              aria-label="Describe your mission"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {running ? 'Running' : phase === 'done' ? 'Rerun' : 'Run'}
              <ArrowUp className="h-3 w-3" />
            </button>
          </form>
          {(phase === 'idle' || phase === 'done') && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    stop();
                    run(s);
                  }}
                  className="rounded-full border border-border/70 bg-secondary/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Tabs — interactive */}
        <div className="flex items-center gap-4 border-b border-border/70 px-4 text-[12px]">
          {(['targets', 'drafts', 'replies'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 py-2 capitalize transition-colors ${
                tab === t
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t}
            </button>
          ))}
          <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">
            {rows} found · {draftsReady} drafted
          </span>
        </div>

        {tab === 'drafts' ? (
          <DraftsView />
        ) : tab === 'replies' ? (
          <RepliesView />
        ) : (
        /* Target list — fixed 5 slots that populate in place (no reflow) */
        <ul className="flex flex-1 flex-col overflow-hidden">
          {LEADS.map((t, i) => {
            const filled = i < rows;
            if (!filled) {
              return (
                <li key={t.name} className="flex flex-1 items-center gap-3 border-b border-border/40 px-4">
                  <span className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-secondary/60" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <span className="h-2 w-24 animate-pulse rounded bg-secondary/60" />
                    <span className="h-2 w-36 animate-pulse rounded bg-secondary/40" />
                  </div>
                  <span className="h-2 w-12 animate-pulse rounded-full bg-secondary/40" />
                </li>
              );
            }
            const allDone = phase === 'done';
            const isDrafting = phase === 'drafting' && i === 0 && typed.length < EMAIL_PLAIN.length;
            const status = allDone ? 'drafted' : isDrafting ? 'drafting' : phase === 'researching' ? 'scoring' : 'queued';
            const meta =
              status === 'drafted'
                ? { label: 'Drafted', cls: 'border-primary/30 bg-primary/10 text-primary', dot: 'bg-primary', pulse: false }
                : status === 'drafting'
                  ? { label: 'Drafting', cls: 'border-border bg-secondary text-foreground', dot: 'bg-primary', pulse: true }
                  : status === 'scoring'
                    ? { label: 'Scoring', cls: 'border-border bg-secondary text-muted-foreground', dot: 'bg-primary', pulse: true }
                    : { label: 'Queued', cls: 'border-border bg-secondary text-muted-foreground', dot: 'bg-muted-foreground/50', pulse: false };
            return (
              <li
                key={t.name}
                className="flex flex-1 animate-fade-in items-center gap-3 border-b border-border/40 px-4"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground/70 ring-1 ring-border">
                  {t.initials}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">{t.name}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{t.why}</span>
                </div>
                <div className="hidden items-center gap-2 md:flex">
                  <span className="h-1.5 w-14 overflow-hidden rounded-full bg-secondary">
                    <span
                      className="block h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                      style={{ width: `${t.score}%` }}
                    />
                  </span>
                  <span className="w-5 text-right text-[11px] tabular-nums text-muted-foreground">{t.score}</span>
                </div>
                <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.cls}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${meta.dot} ${meta.pulse ? 'animate-pulse' : ''}`} />
                  {meta.label}
                </span>
              </li>
            );
          })}
        </ul>
        )}
      </section>

      {/* Agent panel — the email writing itself */}
      <aside className="hidden w-72 shrink-0 flex-col border-l border-border/70 bg-background/40 lg:flex">
        <div className="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Sparkles className="h-3 w-3" />
            </span>
            <span className="text-[12px] font-semibold text-foreground">
              {phase === 'researching' || phase === 'thinking' ? 'Targeting agent' : 'Sequence agent'}
            </span>
          </div>
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </div>

        <div className="flex flex-1 flex-col gap-2.5 p-3 text-[11px] leading-relaxed">
          {phase === 'idle' && (
            <p className="m-auto max-w-[180px] text-center text-muted-foreground/70">
              Describe a mission and the agents research, draft, and queue it for you.
            </p>
          )}

          {(phase === 'thinking' || phase === 'researching') && (
            <>
              <p className="text-muted-foreground">
                {phase === 'thinking' ? 'Planning the mission…' : 'Researching the web for high-fit companies…'}
              </p>
              <ul className="flex flex-col gap-1.5">
                {LEADS.slice(0, revealed).map((l) => (
                  <li key={l.name} className="flex animate-fade-in items-start gap-2 text-muted-foreground">
                    <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Check className="h-2.5 w-2.5" />
                    </span>
                    <span>
                      <span className="text-foreground">{l.name}</span> · {l.why}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {(phase === 'drafting' || phase === 'done') && (
            <>
              <p className="text-muted-foreground">
                Drafting outreach for <span className="font-medium text-foreground">Resend</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {EMAIL.sources.map((s, i) => {
                  const used = phase === 'done' || i < sourcesUsed;
                  return (
                    <span
                      key={s}
                      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] ${
                        used ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-secondary text-muted-foreground/70'
                      }`}
                    >
                      {used && <Check className="h-2 w-2" />}
                      {s}
                    </span>
                  );
                })}
              </div>

              <div className="h-[168px] overflow-hidden rounded-lg border border-border/70 bg-card/80 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                <div className="mb-1.5 flex flex-col gap-0.5 border-b border-border/50 pb-1.5 text-[10px]">
                  <span><span className="text-muted-foreground/60">To</span> <span className="text-foreground">{EMAIL.to}</span></span>
                  <span className="truncate"><span className="text-muted-foreground/60">Re</span> <span className="text-foreground">{EMAIL.subject}</span></span>
                </div>
                <p className="whitespace-pre-wrap">
                  {phase === 'done' ? renderRich(EMAIL.body) : typed}
                  {phase === 'drafting' && (
                    <span className="ml-px inline-block h-[1em] w-[2px] -translate-y-[1px] animate-pulse bg-primary align-middle" />
                  )}
                </p>
              </div>

              <div className="mt-auto flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                <GitBranch className="h-3 w-3 shrink-0 text-primary" />
                <span className="truncate">q1-sponsorship ← resend · 1/3</span>
                {phase === 'done' && (
                  <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
                    Ready
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-1.5">
                <span className="flex-1 truncate text-[11px] text-muted-foreground/70">Message the agent…</span>
                <Paperclip className="h-3 w-3 text-muted-foreground" />
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <ArrowUp className="h-3 w-3" />
                </span>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// Drafts tab — the composed email, reviewable and ready to send.
function DraftsView() {
  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4 text-[12px]">
      <div className="flex flex-col gap-1 border-b border-border/60 pb-2 text-[11px]">
        <span><span className="text-muted-foreground/60">To</span> <span className="text-foreground">{EMAIL.to}</span></span>
        <span className="truncate"><span className="text-muted-foreground/60">Subject</span> <span className="text-foreground">{EMAIL.subject}</span></span>
      </div>
      <p className="overflow-hidden whitespace-pre-wrap leading-relaxed text-muted-foreground">
        {renderRich(EMAIL.body)}
      </p>
      <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          3 sources cited
        </span>
        <span className="rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground">Send</span>
      </div>
    </div>
  );
}

// Replies tab — incoming replies, auto-classified.
const HERO_REPLIES: { from: string; initials: string; snippet: string; tag: string; ok?: boolean }[] = [
  { from: 'Jess at Resend', initials: 'JR', snippet: 'Interesting, can you send tiers?', tag: 'Interested', ok: true },
  { from: 'Marco at Linear', initials: 'ML', snippet: 'Not this quarter, ping me in Q3.', tag: 'Not now' },
  { from: 'Dana at Clerk', initials: 'DC', snippet: 'I am not the right person for this.', tag: 'Wrong person' },
];

function RepliesView() {
  return (
    <ul className="flex flex-1 flex-col overflow-hidden">
      {HERO_REPLIES.map((r) => (
        <li key={r.from} className="flex flex-1 items-center gap-3 border-b border-border/40 px-4">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground/70 ring-1 ring-border">
            {r.initials}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] font-medium text-foreground">{r.from}</span>
            <span className="truncate text-[11px] text-muted-foreground">{r.snippet}</span>
          </div>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              r.ok ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-secondary text-muted-foreground'
            }`}
          >
            {r.tag}
          </span>
        </li>
      ))}
    </ul>
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
