import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Target, FileText, Inbox as InboxIcon, Check, ArrowUpRight } from 'lucide-react';
import { Logo } from '../components/Logo';
import { BrowserFrame, HeroAppMock, PipelineMock, DraftMock, InboxMock } from '../components/AppMockups';
import { GenerativeMountains } from '../components/GenerativeMountains';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { cn } from '@/lib/utils';
import { PLANS, PLAN_ORDER } from '../../shared/plans';

const REPLACES = ['Apollo', 'LinkedIn', 'ChatGPT', 'Spreadsheets', 'Gmail'];

const HOW = [
  { step: '01', title: 'Tell us the mission', body: 'Pick a mode, describe what you are sending, and who you want to reach. Add your LinkedIn and we auto-fill your bio, proof points, and tone.' },
  { step: '02', title: 'Agents do the legwork', body: 'Targeting, evidence, contacts, and sequence agents run in one click. They research the web for the right companies and people, then verify the details.' },
  { step: '03', title: 'Review, send, follow up', body: 'Approve drafts in your voice and send via Gmail. Follow-ups go out on their cadence and stop the moment you mark a contact as replied.' },
];

const MODES = [
  { title: 'Sponsorship', blurb: 'Get devtools, brands, and platforms to sponsor your event or community.' },
  { title: 'BD / Partnerships', blurb: 'Land integration, co-marketing, and channel deals that move the needle.' },
  { title: 'Internship / Job', blurb: 'Reach hiring managers with proof of fit, not another generic ask.' },
  { title: 'Recruiting', blurb: 'Source senior candidates with messages tied to their actual work.' },
  { title: 'Cold Sales', blurb: 'Book meetings off real intent signals: funding, hiring, launches.' },
];

const FEATURES = [
  {
    eyebrow: 'Targeting',
    icon: Target,
    title: 'The right companies, ranked by why-now.',
    body: 'The targeting agent finds high-fit companies and scores each one on a real reason to reach out today: a funding round, a launch, a hiring signal. No scraping spreadsheets, no guessing.',
    bullets: ['Web research, ranked by fit and recency', 'Verified emails and the actual decision-maker', 'Evidence sourced per company, with citations'],
    url: 'app.outreachos.com/missions',
    mock: <PipelineMock />,
  },
  {
    eyebrow: 'Drafts',
    icon: FileText,
    title: 'Personalization with receipts.',
    body: 'Every line in every draft is anchored to a sourced bullet, so personalization is not a Mad Lib. The model cannot flatter what it has not read. You review, tweak, and send in your own voice.',
    bullets: ['Each claim tied to a citation', 'Written in your tone, from your profile', 'A 3-touch sequence, ready to send'],
    url: 'app.outreachos.com/draft',
    mock: <DraftMock />,
  },
  {
    eyebrow: 'Guardrails',
    icon: InboxIcon,
    title: 'Your inbox stays yours.',
    body: 'OutreachOS connects to Gmail with send-only access, so it can never read your mail. Replies land in your inbox like any other email; mark a contact as replied and their scheduled follow-ups stop.',
    bullets: ['Send-only Gmail access, it cannot read your mail', 'Follow-ups stop when you mark a contact replied', 'Suppressed and unsubscribed addresses are never emailed'],
    url: 'app.outreachos.com/missions',
    mock: <InboxMock />,
  },
];

const FAQ = [
  { q: 'Do I need a data-provider subscription?', a: 'No. The agents research the open web to find high-fit companies and the right decision-makers, then verify contact details. Just connect Gmail and go.' },
  { q: 'How does it send email?', a: 'Through your own Gmail with send-only access. OutreachOS can send the emails you approve, and it can never read your inbox.' },
  { q: 'Is it autonomous, or do I stay in control?', a: 'Initial emails always wait for your approval. Once you send, follow-ups go out on schedule, with a suppression list and a one-click reply-stop as guardrails.' },
  { q: 'Does it follow up?', a: 'Yes. Follow-ups are scheduled and sent on cadence. Mark a contact as replied and theirs stop; suppressed addresses are never emailed.' },
  { q: 'What does it run on?', a: 'Google Gemini powers the agents. Your data lives in your account; emails send from your Gmail.' },
];

/* Fades + lifts its children into place when they scroll into view (once).
   Transforms opacity/translate only, ease-out, no bounce. Honors reduced motion. */
function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'span' | 'li';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const style: CSSProperties = {
    opacity: shown ? 1 : 0,
    transform: shown ? 'none' : 'translateY(18px)',
    transition: `opacity 640ms cubic-bezier(0.22,1,0.36,1) ${delay}ms, transform 640ms cubic-bezier(0.22,1,0.36,1) ${delay}ms`,
    willChange: 'opacity, transform',
  };

  return (
    <Tag ref={ref as never} className={className} style={style}>
      {children}
    </Tag>
  );
}

function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-14 max-w-2xl">
      <h2 className="text-balance font-display text-3xl font-semibold tracking-[-0.02em] text-foreground md:text-[2.5rem] md:leading-[1.08]">
        {title}
      </h2>
      {sub && <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function Landing() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground [overflow-x:clip]">
      {/* Nav */}
      <header
        className={cn(
          'fixed inset-x-0 top-0 z-50 transition-colors duration-200',
          scrolled ? 'border-b border-border bg-background/95 backdrop-blur-sm' : 'border-b border-transparent'
        )}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:px-8">
          <Logo size={24} variant="mono-light" />
          <nav className="hidden items-center gap-9 text-sm text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">Features</a>
            <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#modes" className="transition-colors hover:text-foreground">Modes</a>
            <a href="#pricing" className="transition-colors hover:text-foreground">Pricing</a>
            <a href="#faq" className="transition-colors hover:text-foreground">FAQ</a>
          </nav>
          <div className="flex items-center gap-1.5">
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              <Link to="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="btn-glow border-0 font-medium text-primary-foreground">
              <Link to="/sign-up">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative isolate overflow-hidden px-5 pb-14 pt-28 md:pb-16 md:pt-32">
          {/* matte backdrop: flat ground + a faint static grid + the generative green
              particle terrain as the one moment of motion. No color-wash gradients. */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            <div
              className="bg-fade-grid absolute inset-0"
              style={{
                maskImage: 'radial-gradient(120% 70% at 50% 0%, #000 30%, transparent 78%)',
                WebkitMaskImage: 'radial-gradient(120% 70% at 50% 0%, #000 30%, transparent 78%)',
              }}
            />
            {/* particle terrain, faded into the matte ground via an opacity mask only */}
            <div
              className="absolute inset-x-0 bottom-0 h-[78%] opacity-90"
              style={{
                maskImage: 'linear-gradient(to bottom, transparent 0%, #000 38%, #000 86%, transparent 100%)',
                WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, #000 38%, #000 86%, transparent 100%)',
              }}
            >
              <GenerativeMountains className="h-full w-full" />
            </div>
          </div>

          <div className="mx-auto max-w-3xl text-center">
            <Reveal as="div" delay={0}>
              <h1 className="text-balance font-display font-semibold leading-[1.03] tracking-[-0.035em] text-foreground text-[clamp(2.6rem,6.2vw,4.75rem)]">
                Cold outreach that writes
                <br className="hidden sm:block" /> and sends itself.
              </h1>
            </Reveal>
            <Reveal as="div" delay={90}>
              <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
                OutreachOS finds the right companies, writes personalized emails backed by real buying
                signals, and sends them from your Gmail. You review and approve.
              </p>
            </Reveal>
            <Reveal as="div" delay={180} className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="btn-glow gap-2 border-0 px-6 font-medium text-primary-foreground">
                <Link to="/sign-up">
                  Start free <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-border bg-transparent px-6 font-medium text-foreground hover:bg-secondary/60"
              >
                <a href="#how">See how it works</a>
              </Button>
            </Reveal>
            <Reveal as="div" delay={260}>
              <p className="mt-5 text-sm text-muted-foreground">Runs on Google Gemini. Connect Gmail to send.</p>
            </Reveal>
          </div>

          {/* hero product shot — matte frame, single soft shadow, no gradient ring or glow */}
          <Reveal as="div" delay={340} className="relative mx-auto mt-12 max-w-5xl md:mt-14">
            <BrowserFrame url="app.outreachos.com/missions" bodyClassName="p-0">
              <HeroAppMock />
            </BrowserFrame>
          </Reveal>
        </section>

        {/* Replaces strip */}
        <section className="border-y border-border/70">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-5 px-5 py-8 md:flex-row md:gap-10 md:px-8">
            <span className="shrink-0 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/80">
              Replaces the stack
            </span>
            <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3 md:justify-start">
              {REPLACES.map((tool) => (
                <span key={tool} className="font-display text-base font-medium text-foreground/65">
                  {tool}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <ArrowRight className="h-3.5 w-3.5" /> one mission
              </span>
            </div>
          </div>
        </section>

        {/* How it works — the simple 3-step loop, before the deep feature dives */}
        <section id="how">
          <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-24">
            <Reveal>
              <SectionHead
                title="Three steps, start to sent."
                sub="One mission in, a reviewable pipeline out. You stay in the approval seat the whole way."
              />
            </Reveal>
            <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
              {HOW.map((h, i) => (
                <Reveal key={h.step} delay={i * 90} className="flex flex-col bg-card p-7">
                  <span className="font-mono text-sm text-primary">{h.step}</span>
                  <h3 className="mt-5 text-lg font-semibold tracking-[-0.01em] text-foreground">{h.title}</h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{h.body}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Features — the deep dives behind each step */}
        <section id="features" className="border-t border-border/70">
          <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-32">
            <Reveal>
              <SectionHead title="Inside the pipeline." />
            </Reveal>
            <div className="flex flex-col gap-20 md:gap-28">
              {FEATURES.map((f, i) => (
                <Reveal
                  key={f.eyebrow}
                  className={`grid items-center gap-12 lg:grid-cols-2 ${i % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''}`}
                >
                  <div>
                    <span className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      <f.icon className="h-4 w-4 text-primary" /> {f.eyebrow}
                    </span>
                    <h3 className="mt-4 text-balance font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-foreground">
                      {f.title}
                    </h3>
                    <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{f.body}</p>
                    <ul className="mt-7 flex flex-col gap-3.5">
                      {f.bullets.map((b) => (
                        <li key={b} className="flex items-start gap-3 text-sm text-foreground/90">
                          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                            <Check className="h-3 w-3" />
                          </span>
                          {b}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <BrowserFrame url={f.url}>{f.mock}</BrowserFrame>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Modes */}
        <section id="modes" className="border-t border-border/70">
          <div className="mx-auto max-w-6xl px-5 py-20 md:px-8 md:py-24">
            <Reveal>
              <SectionHead
                title="Five modes. One pipeline."
                sub="Same machine underneath; the targeting, evidence, and tone shift to the job at hand."
              />
            </Reveal>
            <div className="grid gap-x-12 sm:grid-cols-2">
              {MODES.map((m, i) => (
                <Reveal
                  key={m.title}
                  delay={(i % 2) * 80}
                  className="flex items-baseline gap-5 border-t border-border py-6"
                >
                  <span className="font-mono text-xs text-muted-foreground/60">{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <h3 className="text-base font-semibold text-foreground">{m.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{m.blurb}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="border-t border-border/70">
          <div className="mx-auto max-w-6xl px-5 py-24 md:px-8 md:py-28">
            <Reveal>
              <SectionHead title="Start free. Scale when it works." />
            </Reveal>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {PLAN_ORDER.map((id, i) => {
                const plan = PLANS[id];
                const featured = id === 'pro';
                return (
                  <Reveal
                    key={id}
                    delay={i * 70}
                    className={cn(
                      'relative flex flex-col rounded-xl border p-6',
                      featured ? 'border-primary/50 bg-primary/[0.04]' : 'border-border bg-card'
                    )}
                  >
                    {featured && (
                      <span className="absolute -top-2.5 left-6 rounded-full border border-primary/40 bg-background px-2.5 py-0.5 text-[11px] font-medium text-primary">
                        Most popular
                      </span>
                    )}
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">{plan.name}</h3>
                    <div className="mt-4 flex items-baseline gap-1">
                      {plan.priceMonthly === 0 ? (
                        <span className="font-display text-[2.5rem] font-semibold tracking-tight text-foreground">Free</span>
                      ) : (
                        <>
                          <span className="font-display text-[2.5rem] font-semibold tracking-tight text-foreground">${plan.priceMonthly}</span>
                          <span className="text-sm text-muted-foreground">/mo</span>
                        </>
                      )}
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{plan.blurb}</p>
                    <ul className="mb-8 mt-6 flex flex-col gap-3">
                      {plan.features.map((feat) => (
                        <li key={feat} className="flex items-start gap-2.5 text-sm text-foreground/85">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          {feat}
                        </li>
                      ))}
                    </ul>
                    <Button
                      asChild
                      size="sm"
                      className={cn(
                        'mt-auto w-full font-medium',
                        featured
                          ? 'btn-glow border-0 text-primary-foreground'
                          : 'border border-border bg-transparent text-foreground hover:bg-secondary/60'
                      )}
                    >
                      <Link to="/sign-up">{plan.priceMonthly === 0 ? 'Start free' : `Choose ${plan.name}`}</Link>
                    </Button>
                  </Reveal>
                );
              })}
            </div>
            <p className="mt-8 max-w-xl text-sm text-muted-foreground/80">
              Every plan runs the full agent pipeline. Pick a plan after you sign up; upgrade, downgrade, or cancel
              anytime from Settings.
            </p>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="border-t border-border/70">
          <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 md:grid-cols-[0.8fr_1.2fr] md:px-8 md:py-24">
            <Reveal>
              <SectionHead title="Questions, answered." />
            </Reveal>
            <Reveal delay={80}>
              <Accordion type="single" collapsible className="w-full">
                {FAQ.map((f) => (
                  <AccordionItem key={f.q} value={f.q} className="border-border">
                    <AccordionTrigger className="text-left text-base font-medium text-foreground hover:no-underline">
                      {f.q}
                    </AccordionTrigger>
                    <AccordionContent className="max-w-prose text-sm leading-relaxed text-muted-foreground">
                      {f.a}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </Reveal>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border/70">
          <div className="mx-auto max-w-6xl px-5 py-24 md:px-8">
            <Reveal className="flex flex-col items-start gap-8 rounded-2xl border border-border bg-card p-10 md:flex-row md:items-center md:justify-between md:p-14">
              <div className="max-w-lg">
                <h2 className="text-balance font-display text-3xl font-semibold tracking-[-0.02em] text-foreground md:text-[2.5rem] md:leading-[1.08]">
                  Stop tab-hopping. Start sending.
                </h2>
                <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                  Replace the LinkedIn, ChatGPT, spreadsheets, and Gmail juggling with one mission, one click,
                  one inbox.
                </p>
              </div>
              <Button asChild size="lg" className="btn-glow shrink-0 gap-2 border-0 px-7 font-medium text-primary-foreground">
                <Link to="/sign-up">
                  Create your account <ArrowUpRight className="h-4 w-4" />
                </Link>
              </Button>
            </Reveal>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70 px-5 py-16 md:px-8">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-12 md:flex-row">
          <div className="max-w-xs">
            <Logo size={22} variant="mono-light" />
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">Agentic cold outreach, end to end.</p>
          </div>
          <div className="flex gap-16 sm:gap-24">
            <div className="flex flex-col gap-3 text-sm">
              <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/70">Product</h4>
              <a href="#features" className="text-muted-foreground transition-colors hover:text-foreground">Features</a>
              <a href="#how" className="text-muted-foreground transition-colors hover:text-foreground">How it works</a>
              <a href="#modes" className="text-muted-foreground transition-colors hover:text-foreground">Modes</a>
              <a href="#pricing" className="text-muted-foreground transition-colors hover:text-foreground">Pricing</a>
              <a href="#faq" className="text-muted-foreground transition-colors hover:text-foreground">FAQ</a>
            </div>
            <div className="flex flex-col gap-3 text-sm">
              <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/70">Account</h4>
              <Link to="/sign-in" className="text-muted-foreground transition-colors hover:text-foreground">Sign in</Link>
              <Link to="/sign-up" className="text-muted-foreground transition-colors hover:text-foreground">Sign up</Link>
              <Link to="/forgot-password" className="text-muted-foreground transition-colors hover:text-foreground">Forgot password</Link>
            </div>
            <div className="flex flex-col gap-3 text-sm">
              <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/70">Legal</h4>
              <Link to="/privacy" className="text-muted-foreground transition-colors hover:text-foreground">Privacy</Link>
              <Link to="/terms" className="text-muted-foreground transition-colors hover:text-foreground">Terms</Link>
            </div>
          </div>
        </div>
        <div className="mx-auto mt-12 flex max-w-6xl flex-col items-center justify-between gap-2 border-t border-border/60 pt-6 text-xs text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} OutreachOS</span>
          <span>Built for senders who actually follow through.</span>
        </div>
      </footer>
    </div>
  );
}
