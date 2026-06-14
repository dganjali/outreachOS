// Landing "agent flow" - an illustrative, animated pipeline of the four agents
// that run on one click: Targeting → Evidence → Contacts → Sequence. A signal
// beam travels the connectors and the active node cycles left to right. Matte
// dark theme, hairline borders, single forest-green accent. Honors reduced motion.

import { useEffect, useRef, useState } from 'react';
import { Target, FileSearch, UserCheck, Send } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AgentNode {
  icon: LucideIcon;
  label: string;
  title: string;
  body: string;
}

const AGENTS: AgentNode[] = [
  { icon: Target, label: 'Targeting', title: 'Finds the accounts', body: 'High-fit companies, each scored on a real why-now.' },
  { icon: FileSearch, label: 'Evidence', title: 'Gathers the proof', body: 'Sourced bullets per company, every claim cited.' },
  { icon: UserCheck, label: 'Contacts', title: 'Verifies the person', body: 'The actual decision-maker and a checked email.' },
  { icon: Send, label: 'Sequence', title: 'Writes the touches', body: 'A 3-step sequence in your voice, ready to send.' },
];

/* Horizontal on desktop, vertical on mobile. The beam direction follows. */
function Connector({ delay }: { delay: number }) {
  return (
    <div className="flex shrink-0 items-center justify-center md:w-14 lg:w-20" aria-hidden>
      {/* mobile: vertical */}
      <div className="relative h-7 w-px overflow-hidden bg-border md:hidden">
        <div
          className="af-beam absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-transparent via-primary to-transparent"
          style={{ animation: `af-beam-y 2.4s linear infinite`, animationDelay: `${delay}ms` }}
        />
      </div>
      {/* desktop: horizontal */}
      <div className="relative hidden h-px w-full overflow-hidden bg-border md:block">
        <div
          className="af-beam absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent"
          style={{ animation: `af-beam-x 2.4s linear infinite`, animationDelay: `${delay}ms` }}
        />
      </div>
    </div>
  );
}

export function AgentFlow() {
  const [active, setActive] = useState(0);
  const reduceRef = useRef(false);

  useEffect(() => {
    reduceRef.current = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceRef.current) return;
    const id = window.setInterval(() => setActive((a) => (a + 1) % AGENTS.length), 1600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="rounded-xl border border-border bg-card p-6 md:p-9">
      <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
        {AGENTS.map((agent, i) => {
          const isActive = i === active && !reduceRef.current;
          const Icon = agent.icon;
          return (
            <div key={agent.label} className="contents">
              <div
                className={cn(
                  'group relative flex flex-1 flex-col rounded-lg border p-5 transition-colors duration-500',
                  isActive ? 'border-primary/40 bg-primary/[0.04]' : 'border-border bg-background/40'
                )}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-md border transition-colors duration-500',
                      isActive ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-secondary/40 text-muted-foreground'
                    )}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-muted-foreground/60">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {agent.label}
                  </span>
                  {isActive && (
                    <span
                      className="af-dot h-1.5 w-1.5 rounded-full bg-primary"
                      style={{ animation: 'af-dot-pulse 1.2s ease-in-out infinite' }}
                      aria-hidden
                    />
                  )}
                </div>
                <h4 className="mt-1.5 text-[0.95rem] font-semibold tracking-[-0.01em] text-foreground">
                  {agent.title}
                </h4>
                <p className="mt-1.5 text-[0.8rem] leading-relaxed text-muted-foreground">{agent.body}</p>
              </div>
              {i < AGENTS.length - 1 && <Connector delay={i * 800} />}
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex items-center justify-center gap-2 text-xs text-muted-foreground/70">
        <span className="h-px w-6 bg-border" />
        One click. The agents run end to end and hand you a reviewable pipeline.
        <span className="h-px w-6 bg-border" />
      </div>
    </div>
  );
}
