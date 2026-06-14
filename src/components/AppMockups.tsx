// Stylized product mockups for the landing page, framed in browser chrome.
// Pure markup (no real screenshots) representing the actual app views:
// the mission pipeline, the draft editor, and the reply inbox. Dark theme.

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LogoMark } from './Logo';
import { cn } from '@/lib/utils';
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
  AudioLines,
  Wand2,
  RefreshCw,
  Lock,
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
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_60px_-36px_rgba(0,0,0,0.7)]">
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
// Hero app mock - an interactive, prompt-driven demo. The viewer enters a
// mission (or one auto-plays) and a pre-scripted sequence runs: the agents
// research, targets stream in with fit scores, and a personalized email writes
// itself, citation by citation. Single green accent, neutral surfaces - no
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

// Top lead's email - « » marks the evidence-backed phrases.
const EMAIL = {
  to: 'jess@resend.com',
  subject: 'Sponsoring our 2026 developer conference?',
  sources: ['Series B · Mar 2026', 'Hiring first DevRel', 'Shipped Vue support'],
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

// Renders a body with one phrase highlighted as a live "selection" (with a small
// contextual edit popover) or as a just-changed span that flashes in. Used by the
// voice mock's highlight-to-refine beat. The rest still resolves «» evidence marks.
function renderEditBody(text: string, target: string, mode: 'select' | 'changed', note?: string) {
  const idx = text.indexOf(target);
  if (!target || idx === -1) return renderRich(text);
  const before = text.slice(0, idx);
  const rest = text.slice(idx + target.length);
  return (
    <>
      {renderRich(before)}
      {mode === 'select' ? (
        <span className="relative rounded-[3px] bg-primary/25 px-0.5 text-foreground ring-1 ring-primary/40">
          {target}
          <span className="absolute bottom-full left-0 z-10 mb-1.5 flex w-max max-w-[230px] items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-[11px] font-medium text-foreground shadow-[0_12px_32px_-12px_rgba(0,0,0,0.75)]">
            <Wand2 className="h-3 w-3 shrink-0 text-primary" />
            <span className="truncate text-muted-foreground">{note || 'Edit selection'}</span>
            <ArrowUp className="h-3 w-3 shrink-0 text-primary" />
          </span>
        </span>
      ) : (
        <span className="animate-fade-in rounded-[3px] bg-primary/15 px-0.5 text-foreground ring-1 ring-primary/30">
          {target}
        </span>
      )}
      {renderRich(rest)}
    </>
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

      {/* Main - prompt + streaming targets */}
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

        {/* Tabs - interactive */}
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
        /* Target list - fixed 5 slots that populate in place (no reflow) */
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

      {/* Agent panel - the email writing itself */}
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

// Drafts tab - the composed email, reviewable and ready to send.
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

// Replies tab - incoming replies, auto-classified.
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

// ---------------------------------------------------------------------------
// Voice calibration mock - the marquee demo. A generic, corporate draft is
// corrected in plain English; a "voice profile" learns the rules behind the
// edit (tone, length, what to cut) live; then the draft rewrites itself in the
// user's voice. Loops between two voices and is fully interactive. Dark theme,
// single green accent - matches the rest of the landing mocks.
// ---------------------------------------------------------------------------

// The demo walks one email down a ladder of ever-smaller edits:
//   before  → the completely-AI formal draft
//   typing  → the one big plain-English correction
//   learning→ the voice profile learns the rules behind it
//   rewrite → the major rewrite (whole email, in your voice)
//   typing2 → a smaller follow-up correction
//   rewrite2→ the smaller rewrite (just the ask line)
//   refine  → surgical highlight edits (lose the em dash, then name the day)
type CalStage = 'before' | 'typing' | 'learning' | 'rewrite' | 'typing2' | 'rewrite2' | 'refine';

type TraitKey = 'Warmth' | 'Brevity' | 'Directness' | 'Formality';
const TRAIT_ORDER: TraitKey[] = ['Warmth', 'Brevity', 'Directness', 'Formality'];

const BEFORE_DRAFT = {
  subject: 'Partnership Opportunity for Mutual Growth',
  body:
    'Dear Jessica,\n\nI hope this email finds you well. I am reaching out to explore a potential synergy between our respective organizations. We believe there is significant value to be unlocked by leveraging our core competencies to drive mutual growth.\n\nI would welcome the opportunity to connect at your earliest convenience.\n\nBest regards,\nAlex',
};
const BEFORE_TRAITS: Record<TraitKey, number> = { Warmth: 36, Brevity: 20, Directness: 32, Formality: 88 };

const stripMarks = (s: string) => s.replace(/[«»]/g, '');
function commonPrefixLen(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}
// Apply the first `upto` highlight edits in order, so each later edit sees the
// earlier ones already baked in.
function applyEdits(body: string, edits: { find: string; replace: string }[], upto: number) {
  let out = body;
  for (let i = 0; i < upto; i += 1) out = out.replace(edits[i].find, edits[i].replace);
  return out;
}

interface Voice {
  label: string;
  majorPrompt: string;
  minorPrompt: string;
  subject: string;
  v1: string; // after the major rewrite — « » mark evidence-backed phrases
  v2: string; // after the smaller rewrite (only the ask line changes)
  traits: Record<TraitKey, number>;
  rules: string[];
  // surgical highlight edits applied to v2, smallest of all; each can teach a new rule
  edits: { find: string; replace: string; note: string; rule: string }[];
}

const VOICES: Record<'direct' | 'warm', Voice> = {
  direct: {
    label: 'Short & direct',
    majorPrompt:
      "Way too stiff. Cut “hope this finds you well,” drop the buzzwords, lowercase the subject, and lead with the why-now. Sound like how I'd actually write it.",
    minorPrompt: 'Closing is mushy — make it a concrete 15-minute call.',
    subject: 'sponsoring devconf 2026?',
    v1:
      "Hey Jess,\n\nSaw Resend «closed Series B this March» and is «hiring its first DevRel» — exactly the crowd we host.\n\nWe pull in 1,400+ engineers a year. Free to grab a call sometime next week?\n\nAlex",
    v2:
      "Hey Jess,\n\nSaw Resend «closed Series B this March» and is «hiring its first DevRel» — exactly the crowd we host.\n\nWe pull in 1,400+ engineers a year. Worth 15 minutes next week?\n\nAlex",
    traits: { Warmth: 74, Brevity: 92, Directness: 90, Formality: 16 },
    rules: ['No buzzwords', 'Lowercase subjects', 'Lead with why-now', 'Use contractions'],
    edits: [
      { find: ' — exactly', replace: ', exactly', note: 'lose the em dash', rule: 'No em dashes' },
      { find: 'next week', replace: 'Tuesday', note: 'name an actual day', rule: 'Name the day' },
    ],
  },
  warm: {
    label: 'Warm & personal',
    majorPrompt:
      'Make it warmer and more human — open with genuine congrats, keep it friendly and a little excited, but still short.',
    minorPrompt: 'Tighten the close — make it a clear 15-minute ask.',
    subject: 'loved what resend shipped this week',
    v1:
      "Hey Jess!\n\nHuge congrats on «closing Series B» — and «shipping Vue support» the same week is wild.\n\nWe host 1,400+ engineers who'd love what you're building. Could I grab a quick call sometime this week?\n\nAlex",
    v2:
      "Hey Jess!\n\nHuge congrats on «closing Series B» — and «shipping Vue support» the same week is wild.\n\nWe host 1,400+ engineers who'd love what you're building. Got 15 minutes this week to chat?\n\nAlex",
    traits: { Warmth: 96, Brevity: 62, Directness: 68, Formality: 28 },
    rules: ['Open with a compliment', 'Friendly + a little excited', 'Keep it short', 'Use contractions'],
    edits: [
      { find: ' — and', replace: ', and', note: 'lose the em dash', rule: 'No em dashes' },
      { find: 'this week', replace: 'Thursday', note: 'name an actual day', rule: 'Name the day' },
    ],
  },
};

function VoiceBars() {
  // Tiny decorative equalizer for the panel header.
  return (
    <span className="flex items-end gap-[2px]" aria-hidden>
      {[6, 11, 8, 13, 7, 10].map((h, i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-primary/70"
          style={{ height: h, animation: `voicePulse 1.1s ease-in-out ${i * 0.12}s infinite` }}
        />
      ))}
    </span>
  );
}

export function VoiceCalibrationMock() {
  const [voiceKey, setVoiceKey] = useState<'direct' | 'warm'>('direct');
  const [stage, setStage] = useState<CalStage>('before');
  const [typedPrompt, setTypedPrompt] = useState('');
  const [typed, setTyped] = useState(0); // chars typed of the active rewrite's tail
  const [traits, setTraits] = useState<Record<TraitKey, number>>(BEFORE_TRAITS);
  const [rulesShown, setRulesShown] = useState(0); // base rules revealed during learning
  const [bonusRules, setBonusRules] = useState<string[]>([]); // rules taught by highlight edits
  const [editIdx, setEditIdx] = useState(0); // which highlight edit is active
  const [editApplied, setEditApplied] = useState(false); // has the active edit swapped in yet
  const [editNote, setEditNote] = useState(''); // typed instruction inside the selection popover
  const interacted = useRef(false);
  const started = useRef(false); // demo has auto-started once it scrolled into view
  const rootRef = useRef<HTMLDivElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const after = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));

  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function runVoice(key: 'direct' | 'warm') {
    clearTimers();
    setVoiceKey(key);
    setStage('before');
    setTypedPrompt('');
    setTyped(0);
    setTraits(BEFORE_TRAITS);
    setRulesShown(0);
    setBonusRules([]);
    setEditIdx(0);
    setEditApplied(false);
    setEditNote('');

    if (reduceMotion) {
      const v = VOICES[key];
      setStage('refine');
      setTraits(v.traits);
      setRulesShown(v.rules.length);
      setBonusRules(v.edits.map((e) => e.rule));
      setEditIdx(v.edits.length - 1);
      setEditApplied(true);
      return;
    }
    after(750, () => setStage('typing'));
  }

  // Act 1 — type the one big correction into the prompt bar, then start learning.
  useEffect(() => {
    if (stage !== 'typing') return;
    const full = VOICES[voiceKey].majorPrompt;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTypedPrompt(full.slice(0, i));
      if (i >= full.length) {
        clearInterval(id);
        after(520, () => setStage('learning'));
      }
    }, 22);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, voiceKey]);

  // Act 2 — the voice profile learns: traits slide to target, rules pop in, then rewrite.
  useEffect(() => {
    if (stage !== 'learning') return;
    const v = VOICES[voiceKey];
    after(120, () => setTraits(v.traits));
    v.rules.forEach((_, i) => after(360 + i * 200, () => setRulesShown(i + 1)));
    after(360 + v.rules.length * 200 + 620, () => setStage('rewrite'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, voiceKey]);

  // Acts 3 & 4 — rewrites. The major rewrite (before → v1) retypes the whole email;
  // the smaller rewrite (v1 → v2) shares a long common prefix, so only the ask line
  // appears to change. One mechanism, two magnitudes.
  useEffect(() => {
    if (stage !== 'rewrite' && stage !== 'rewrite2') return;
    const v = VOICES[voiceKey];
    const major = stage === 'rewrite';
    const from = major ? BEFORE_DRAFT.body : v.v1;
    const to = major ? v.v1 : v.v2;
    const prefix = commonPrefixLen(from, to);
    const tailLen = stripMarks(to.slice(prefix)).length;
    setTyped(0);
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTyped(i);
      if (i >= tailLen) {
        clearInterval(id);
        if (major) after(1500, () => { setTypedPrompt(''); setStage('typing2'); });
        else after(1500, () => { setEditIdx(0); setStage('refine'); });
      }
    }, major ? 13 : 24);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, voiceKey]);

  // Bridge — type the smaller follow-up correction, then run the smaller rewrite.
  useEffect(() => {
    if (stage !== 'typing2') return;
    const full = VOICES[voiceKey].minorPrompt;
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setTypedPrompt(full.slice(0, i));
      if (i >= full.length) {
        clearInterval(id);
        after(520, () => setStage('rewrite2'));
      }
    }, 24);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, voiceKey]);

  // Act 5 — surgical highlight edits, one at a time: select a phrase, type a tiny
  // instruction, swap just that span (and learn a new rule), then the next edit.
  useEffect(() => {
    if (stage !== 'refine') return;
    const edits = VOICES[voiceKey].edits;
    const edit = edits[editIdx];
    if (!edit) return;
    setEditApplied(false);
    setEditNote('');
    let i = 0;
    const id = setInterval(() => {
      i += 1;
      setEditNote(edit.note.slice(0, i));
      if (i >= edit.note.length) {
        clearInterval(id);
        after(1300, () => {
          setEditApplied(true);
          setBonusRules((prev) => (prev.includes(edit.rule) ? prev : [...prev, edit.rule]));
        });
        const isLast = editIdx >= edits.length - 1;
        if (isLast) {
          if (!interacted.current) after(1300 + 2800, () => runVoice(voiceKey === 'direct' ? 'warm' : 'direct'));
        } else {
          after(1300 + 1600, () => setEditIdx(editIdx + 1));
        }
      }
    }, 26);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, voiceKey, editIdx]);

  // Auto-play only once the section actually scrolls into view (not on mount),
  // so the demo greets the viewer fresh rather than finishing off-screen.
  useEffect(() => {
    const el = rootRef.current;
    if (reduceMotion) {
      runVoice('direct');
      return clearTimers;
    }
    if (!el || typeof IntersectionObserver === 'undefined') {
      after(650, () => !interacted.current && runVoice('direct'));
      return clearTimers;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !started.current && !interacted.current) {
          started.current = true;
          after(350, () => runVoice('direct'));
        }
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (key: 'direct' | 'warm') => {
    interacted.current = true;
    runVoice(key);
  };

  const v = VOICES[voiceKey];
  const isRewrite = stage === 'rewrite' || stage === 'rewrite2';
  const isRefine = stage === 'refine';
  const calibrated = stage === 'typing2' || isRewrite || isRefine; // voice already learned
  const showNewSubject = stage !== 'before' && stage !== 'typing' && stage !== 'learning';
  const activePromptFull = stage === 'typing2' || stage === 'rewrite2' || isRefine ? v.minorPrompt : v.majorPrompt;
  const promptTyping = stage === 'typing' || stage === 'typing2';

  // The email body, resolved per stage.
  let bodyEl: ReactNode;
  if (stage === 'before' || stage === 'typing' || stage === 'learning') {
    bodyEl = (
      <p className={cn('whitespace-pre-wrap text-muted-foreground transition-opacity duration-300', stage === 'learning' && 'opacity-30')}>
        {BEFORE_DRAFT.body}
      </p>
    );
  } else if (isRewrite) {
    const major = stage === 'rewrite';
    const from = major ? BEFORE_DRAFT.body : v.v1;
    const to = major ? v.v1 : v.v2;
    const prefix = commonPrefixLen(from, to);
    const head = to.slice(0, prefix);
    const tail = stripMarks(to.slice(prefix));
    const done = typed >= tail.length;
    bodyEl = (
      <p className="whitespace-pre-wrap text-foreground/90">
        {done ? (
          renderRich(to)
        ) : (
          <>
            {renderRich(head)}
            {tail.slice(0, typed)}
            <span className="ml-px inline-block h-[1em] w-[2px] -translate-y-[1px] animate-pulse bg-primary align-middle" />
          </>
        )}
      </p>
    );
  } else if (stage === 'typing2') {
    bodyEl = <p className="whitespace-pre-wrap text-foreground/90">{renderRich(v.v1)}</p>;
  } else {
    // refine — highlight one phrase, then swap it
    const base = applyEdits(v.v2, v.edits, editIdx);
    const edit = v.edits[editIdx];
    bodyEl = (
      <p className="whitespace-pre-wrap text-foreground/90">
        {editApplied
          ? renderEditBody(base.replace(edit.find, edit.replace), edit.replace, 'changed')
          : renderEditBody(base, edit.find, 'select', editNote)}
      </p>
    );
  }

  const badge =
    stage === 'before' || stage === 'typing'
      ? { label: 'Generic draft', cls: 'border-border bg-secondary text-muted-foreground', dot: 'bg-muted-foreground/50', live: false }
      : stage === 'learning'
        ? { label: 'Calibrating voice', cls: 'border-border bg-secondary text-foreground', dot: 'bg-primary', live: true }
        : stage === 'rewrite'
          ? { label: 'Rewriting', cls: 'border-border bg-secondary text-foreground', dot: 'bg-primary', live: true }
          : stage === 'typing2'
            ? { label: 'Refining', cls: 'border-border bg-secondary text-foreground', dot: 'bg-primary', live: true }
            : stage === 'rewrite2'
              ? { label: 'Tightening', cls: 'border-border bg-secondary text-foreground', dot: 'bg-primary', live: true }
              : isRefine && !editApplied
                ? { label: 'Editing selection', cls: 'border-border bg-secondary text-foreground', dot: 'bg-primary', live: true }
                : { label: 'In your voice', cls: 'border-primary/30 bg-primary/10 text-primary', dot: 'bg-primary', live: false };

  return (
    <div ref={rootRef} className="flex h-[520px] text-left">
      {/* Draft editor */}
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-border/70 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground/70 ring-1 ring-border">
              RE
            </span>
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-[13px] font-semibold text-foreground">Draft · Resend</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground/70">targeting → drafts → follow-ups</span>
            </div>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${badge.cls}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${badge.dot} ${badge.live ? 'animate-pulse' : ''}`} />
            {badge.label}
          </span>
        </header>

        {/* Email */}
        <div className="flex flex-1 flex-col overflow-hidden px-4 py-3">
          <div className="flex flex-col gap-1 border-b border-border/60 pb-2.5 text-[11px]">
            <span><span className="text-muted-foreground/60">To</span> <span className="text-foreground">jess@resend.com</span></span>
            <span className="flex items-baseline gap-1.5 truncate">
              <span className="text-muted-foreground/60">Subject</span>
              <span className={cn('truncate transition-colors', showNewSubject ? 'text-foreground' : 'text-foreground/80')}>
                {showNewSubject ? v.subject : BEFORE_DRAFT.subject}
              </span>
            </span>
          </div>

          <div className="relative mt-3 flex-1 overflow-hidden text-[12.5px] leading-relaxed">
            {bodyEl}
            {stage === 'learning' && (
              <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
                <span className="inline-flex animate-fade-in items-center gap-1.5 rounded-full border border-primary/30 bg-card/90 px-2.5 py-1 text-[11px] font-medium text-primary shadow-sm backdrop-blur-sm">
                  <Wand2 className="h-3 w-3" /> Rewriting in your voice…
                </span>
              </div>
            )}
          </div>

          {/* Correction bar */}
          <div className="mt-2 border-t border-border/60 pt-3">
            <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background/60 px-3 py-2 focus-within:border-primary/50">
              <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-foreground/90">
                {stage === 'before' ? (
                  <span className="text-muted-foreground/60">Tell the agent what's off — in plain English…</span>
                ) : (
                  <>
                    {typedPrompt}
                    {promptTyping && typedPrompt.length < activePromptFull.length && (
                      <span className="ml-px inline-block h-[1em] w-[2px] -translate-y-[1px] animate-pulse bg-primary align-middle" />
                    )}
                  </>
                )}
              </p>
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <ArrowUp className="h-3 w-3" />
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50">Try a voice</span>
              {(['direct', 'warm'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pick(k)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                    voiceKey === k && stage !== 'before'
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/70 bg-secondary/40 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  )}
                >
                  {VOICES[k].label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => pick(voiceKey)}
                className="ml-auto inline-flex items-center gap-1 rounded-full border border-border/70 bg-secondary/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" /> Replay
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Voice profile */}
      <aside className="hidden w-72 shrink-0 flex-col border-l border-border/70 bg-background/40 md:flex">
        <div className="flex items-center justify-between border-b border-border/70 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/15 text-primary">
              <AudioLines className="h-3 w-3" />
            </span>
            <span className="text-[12px] font-semibold text-foreground">Voice profile</span>
          </div>
          <VoiceBars />
        </div>

        <div className="flex flex-1 flex-col gap-4 p-3.5">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Learned from your edit — not just this line, the <span className="text-foreground">rule behind it</span>.
          </p>

          {/* Trait sliders */}
          <div className="flex flex-col gap-2.5">
            {TRAIT_ORDER.map((t) => (
              <div key={t} className="flex items-center gap-2.5">
                <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{t}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                  <span
                    className="block h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
                    style={{ width: `${traits[t]}%` }}
                  />
                </span>
                <span className="w-6 text-right text-[10px] tabular-nums text-muted-foreground/70">{traits[t]}</span>
              </div>
            ))}
          </div>

          {/* Rules learned */}
          <div>
            <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/50">
              Rules learned
            </p>
            <div className="flex min-h-[58px] flex-wrap content-start gap-1.5">
              {v.rules.map((r, i) => {
                const on = rulesShown > i;
                return (
                  <span
                    key={r}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] transition-all duration-300',
                      on
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'translate-y-1 border-border bg-secondary text-muted-foreground/40 opacity-0'
                    )}
                  >
                    {on && <Check className="h-2.5 w-2.5" />}
                    {r}
                  </span>
                );
              })}
              {/* Rules picked up from the surgical highlight edits */}
              {bonusRules.map((r) => (
                <span
                  key={r}
                  className="inline-flex animate-fade-in items-center gap-1 rounded-full border border-primary/40 bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary"
                >
                  <Check className="h-2.5 w-2.5" />
                  {r}
                </span>
              ))}
            </div>
          </div>

          {/* Lock-in footer */}
          <div className="mt-auto flex flex-col gap-2">
            <div
              className={cn(
                'flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px] transition-colors duration-300',
                calibrated ? 'border-primary/30 bg-primary/[0.06] text-foreground' : 'border-border/70 bg-secondary/30 text-muted-foreground'
              )}
            >
              {calibrated ? <Lock className="h-3 w-3 shrink-0 text-primary" /> : <Sparkles className="h-3 w-3 shrink-0 text-muted-foreground/60" />}
              <span className="truncate">
                {isRefine ? (
                  <>Inline edit · <span className="text-primary">voice held</span></>
                ) : calibrated ? (
                  <>Voice saved · <span className="text-primary">applied to every draft</span></>
                ) : (
                  'Calibrating from your correction…'
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-secondary/40 px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
              <GitBranch className="h-3 w-3 shrink-0 text-primary" />
              <span className="truncate">voice ← your edits</span>
              <span className="ml-auto rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
                {calibrated ? '23 drafts' : 'live'}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
