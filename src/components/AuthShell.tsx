import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Logo } from './Logo';

interface Props {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

const BULLETS = [
  'Web research, ranked by recent "why now" signals',
  'Verified emails and decision-makers per target',
  'Drafts in your voice, sent through your Gmail',
  'Inbox routes replies back with classification + suggestions',
];

export function AuthShell({ title, subtitle, children, footer }: Props) {
  return (
    <div className="grid min-h-dvh bg-background text-foreground lg:grid-cols-[1.05fr_1fr]">
      {/* Marketing panel */}
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-border p-12 lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute inset-0 bg-[linear-gradient(155deg,hsl(153_42%_15%),hsl(160_30%_9%)_45%,hsl(220_26%_6%)_80%)]" />
          <div className="absolute -left-24 -top-10 h-[30rem] w-[30rem] rounded-full bg-primary/25 blur-[120px]" />
          <div
            className="absolute inset-0 opacity-40"
            style={{
              backgroundImage:
                'linear-gradient(to right, hsl(213 30% 60% / 0.06) 1px, transparent 1px), linear-gradient(to bottom, hsl(213 30% 60% / 0.06) 1px, transparent 1px)',
              backgroundSize: '52px 52px',
              maskImage: 'radial-gradient(100% 80% at 0% 0%, #000 30%, transparent 75%)',
              WebkitMaskImage: 'radial-gradient(100% 80% at 0% 0%, #000 30%, transparent 75%)',
            }}
          />
        </div>

        <Logo size={26} variant="mono-light" to="/" />

        <div className="max-w-md">
          <h2 className="font-display text-3xl font-bold leading-tight tracking-tight text-wash">
            One mission in. A ready-to-send pipeline out.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            OutreachOS replaces the LinkedIn → ChatGPT → Sheets → Gmail dance with five agents that
            hand you ranked targets, verified contacts, sourced evidence, and personalized drafts,
            every line anchored in something real.
          </p>
          <ul className="mt-7 flex flex-col gap-3">
            {BULLETS.map((b) => (
              <li key={b} className="flex items-start gap-3 text-sm text-foreground/90">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Check className="h-3 w-3" />
                </span>
                {b}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-sm text-muted-foreground [&_a]:font-medium [&_a]:text-primary hover:[&_a]:text-primary/80">
          Trouble signing in? <Link to="/forgot-password">Reset your password</Link>.
        </p>
      </aside>

      {/* Form panel */}
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo size={26} variant="mono-light" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {subtitle && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
              {subtitle}
            </p>
          )}
          <div className="mt-8">{children}</div>
          {footer && (
            <div className="mt-6 flex flex-col gap-2 text-center text-sm text-muted-foreground [&_a]:font-medium [&_a]:text-primary hover:[&_a]:text-primary/80">
              {footer}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
