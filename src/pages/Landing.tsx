import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles, Target, FileText, Inbox as InboxIcon, Check } from 'lucide-react';
import { Logo } from '../components/Logo';
import { BrowserFrame, PipelineMock, DraftMock, InboxMock } from '../components/AppMockups';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';

const HOW = [
  { step: '01', title: 'Tell us the mission', body: 'Pick a mode, describe what you are sending, and who you want to reach. Add your LinkedIn and we auto-fill your bio, proof points, and tone.' },
  { step: '02', title: 'Agents do the legwork', body: 'Targeting, evidence, contacts, and sequence agents run in one click. They research the web for the right companies and people, then verify the details.' },
  { step: '03', title: 'Review, send, track', body: 'Approve drafts in your voice, send via Gmail, and watch the inbox classify replies with a suggested response queued up.' },
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
    eyebrow: 'Inbox',
    icon: InboxIcon,
    title: 'Replies, sorted and answered.',
    body: 'Send through your Gmail and the inbox classifies every reply, interested, not now, wrong person, with a suggested response queued up. Follow-ups stop the moment someone writes back.',
    bullets: ['Replies classified automatically', 'Suggested responses, ready to edit', 'Follow-ups stop on reply or unsubscribe'],
    url: 'app.outreachos.com/inbox',
    mock: <InboxMock />,
  },
];

const FAQ = [
  { q: 'Do I need a data-provider subscription?', a: 'No. The agents research the open web to find high-fit companies and the right decision-makers, then verify contact details. Just connect Gmail and go.' },
  { q: 'How does it send email?', a: 'Through your own Gmail, over a secure connection. You approve each send, or enable auto-send with guardrails once you trust it.' },
  { q: 'Is it autonomous, or do I stay in control?', a: 'Reviewable by default: every draft waits for your approval. When you are ready, turn on auto-send, with reply-stop and a suppression list as guardrails.' },
  { q: 'Does it follow up?', a: 'Yes. Follow-ups are scheduled and sent on cadence, and stop automatically the moment someone replies or unsubscribes.' },
  { q: 'What does it run on?', a: 'Google Gemini powers the agents. Your data lives in your account; emails send from your Gmail.' },
];

function SectionHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="mx-auto mb-12 max-w-2xl text-center">
      <span className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</span>
      <h2 className="mt-3 text-balance font-display text-3xl font-bold tracking-tight text-wash md:text-4xl">
        {title}
      </h2>
    </div>
  );
}

export function Landing() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="min-h-dvh bg-background text-foreground [overflow-x:clip]">
      {/* Nav */}
      <header
        className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
          scrolled ? 'border-b border-border/70 bg-background/80 backdrop-blur-xl' : 'border-b border-transparent'
        }`}
      >
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:px-8">
          <Logo size={26} variant="mono-light" />
          <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
            <a href="#features" className="transition-colors hover:text-foreground">Features</a>
            <a href="#how" className="transition-colors hover:text-foreground">How it works</a>
            <a href="#modes" className="transition-colors hover:text-foreground">Modes</a>
            <a href="#faq" className="transition-colors hover:text-foreground">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
              <Link to="/sign-in">Sign in</Link>
            </Button>
            <Button asChild size="sm" className="btn-glow border-0 font-semibold text-primary-foreground">
              <Link to="/sign-up">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden px-5 pb-20 pt-36 md:pt-44">
          {/* background glow + grid */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute left-1/2 top-0 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-primary/20 blur-[140px]" />
            <div
              className="absolute inset-0 opacity-[0.55]"
              style={{
                backgroundImage:
                  'linear-gradient(to right, hsl(213 30% 60% / 0.05) 1px, transparent 1px), linear-gradient(to bottom, hsl(213 30% 60% / 0.05) 1px, transparent 1px)',
                backgroundSize: '60px 60px',
                maskImage: 'radial-gradient(110% 70% at 50% 0%, #000 30%, transparent 75%)',
                WebkitMaskImage: 'radial-gradient(110% 70% at 50% 0%, #000 30%, transparent 75%)',
              }}
            />
          </div>

          <div className="mx-auto max-w-3xl text-center animate-fade-in">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3.5 py-1.5 text-xs font-medium text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              Agentic cold outreach
            </span>
            <h1 className="mt-6 text-balance font-display text-5xl font-bold leading-[1.05] tracking-tight text-wash md:text-7xl">
              Cold outreach that writes and sends itself.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground">
              One mission in: a mode, an offer, an audience. OutreachOS researches the targets, finds
              the right people, sources the evidence, and drafts personalized emails, sent from your
              Gmail with replies routed back to you.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="btn-glow gap-2 border-0 px-6 font-semibold text-primary-foreground">
                <Link to="/sign-up">
                  Start free <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-border bg-secondary/30 px-6 font-medium backdrop-blur">
                <a href="#how">See how it works</a>
              </Button>
            </div>
            <p className="mt-5 text-sm text-muted-foreground/80">Runs on Google Gemini. Connect Gmail to send.</p>
          </div>

          {/* hero product shot */}
          <div className="relative mx-auto mt-16 max-w-4xl animate-fade-in">
            <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-8 bottom-0 -z-10 rounded-[2rem] bg-primary/10 blur-[80px]" />
            {/* gradient ring frame */}
            <div className="rounded-2xl bg-gradient-to-b from-primary/30 via-border/50 to-transparent p-px shadow-[0_50px_140px_-40px_rgba(0,0,0,0.95)]">
              <BrowserFrame url="app.outreachos.com/missions">
                <PipelineMock />
              </BrowserFrame>
            </div>

            {/* floating accents — parked fully beside the frame, no content overlap */}
            <div className="absolute right-full top-12 mr-5 hidden animate-fade-in items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 shadow-2xl backdrop-blur xl:flex">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Target className="h-3.5 w-3.5" />
              </span>
              <div className="leading-tight">
                <div className="text-xs font-semibold text-foreground">92 fit score</div>
                <div className="text-[11px] text-muted-foreground">why-now verified</div>
              </div>
            </div>
            <div className="absolute left-full bottom-16 ml-5 hidden animate-fade-in items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 shadow-2xl backdrop-blur xl:flex">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Check className="h-3.5 w-3.5" />
              </span>
              <div className="leading-tight">
                <div className="text-xs font-semibold text-foreground">Reply in 2h</div>
                <div className="text-[11px] text-muted-foreground">classified: interested</div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="mx-auto max-w-6xl px-5 py-24 md:px-8">
          <SectionHead eyebrow="The pipeline" title="Mission in. Ready-to-send pipeline out." />
          <div className="flex flex-col gap-20">
            {FEATURES.map((f, i) => (
              <div
                key={f.eyebrow}
                className={`grid items-center gap-10 lg:grid-cols-2 ${i % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''}`}
              >
                <div>
                  <span className="inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                    <f.icon className="h-4 w-4" /> {f.eyebrow}
                  </span>
                  <h3 className="mt-3 text-balance font-display text-3xl font-bold tracking-tight text-foreground">
                    {f.title}
                  </h3>
                  <p className="mt-4 text-base leading-relaxed text-muted-foreground">{f.body}</p>
                  <ul className="mt-6 flex flex-col gap-3">
                    {f.bullets.map((b) => (
                      <li key={b} className="flex items-start gap-3 text-sm text-foreground/90">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                          <Check className="h-3 w-3" />
                        </span>
                        {b}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="relative">
                  <div aria-hidden className="pointer-events-none absolute -inset-6 -z-10 rounded-3xl bg-primary/5 blur-3xl" />
                  <BrowserFrame url={f.url}>{f.mock}</BrowserFrame>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-6xl px-5 py-24 md:px-8">
          <SectionHead eyebrow="How it works" title="Mission in. Pipeline out. Three steps." />
          <div className="grid gap-5 md:grid-cols-3">
            {HOW.map((h) => (
              <div key={h.step} className="panel p-6">
                <span className="font-display text-2xl font-bold text-primary/70">{h.step}</span>
                <h3 className="mt-4 text-lg font-semibold text-foreground">{h.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{h.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Modes */}
        <section id="modes" className="mx-auto max-w-6xl px-5 py-24 md:px-8">
          <SectionHead eyebrow="Built for any mission" title="Five modes. Same pipeline. Different angles." />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MODES.map((m) => (
              <div
                key={m.title}
                className="group rounded-xl border border-border bg-card p-6 transition-colors hover:border-primary/40 hover:bg-secondary/30"
              >
                <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {m.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.blurb}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="mx-auto max-w-3xl px-5 py-24 md:px-8">
          <SectionHead eyebrow="FAQ" title="Questions, answered." />
          <Accordion type="single" collapsible className="w-full">
            {FAQ.map((f) => (
              <AccordionItem key={f.q} value={f.q} className="border-border">
                <AccordionTrigger className="text-left text-base font-medium text-foreground hover:no-underline">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm leading-relaxed text-muted-foreground">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>

        {/* CTA */}
        <section className="px-5 py-24 md:px-8">
          <div className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-primary/20 p-12 text-center md:p-16">
            <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-primary/15 to-transparent" />
            <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />
            <h2 className="text-balance font-display text-4xl font-bold tracking-tight text-wash md:text-5xl">
              Stop tab-hopping. Start sending.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
              Replace the LinkedIn, ChatGPT, spreadsheets, and Gmail juggling with one mission, one
              click, one inbox.
            </p>
            <Button asChild size="lg" className="btn-glow mt-8 gap-2 border-0 px-7 font-semibold text-primary-foreground">
              <Link to="/sign-up">
                Create your account <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70 px-5 py-14 md:px-8">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-10 md:flex-row">
          <div className="max-w-xs">
            <Logo size={24} variant="mono-light" />
            <p className="mt-4 text-sm text-muted-foreground">Agentic cold outreach, end to end.</p>
          </div>
          <div className="flex gap-16">
            <div className="flex flex-col gap-3 text-sm">
              <h4 className="font-semibold text-foreground">Product</h4>
              <a href="#features" className="text-muted-foreground transition-colors hover:text-foreground">Features</a>
              <a href="#how" className="text-muted-foreground transition-colors hover:text-foreground">How it works</a>
              <a href="#modes" className="text-muted-foreground transition-colors hover:text-foreground">Modes</a>
              <a href="#faq" className="text-muted-foreground transition-colors hover:text-foreground">FAQ</a>
            </div>
            <div className="flex flex-col gap-3 text-sm">
              <h4 className="font-semibold text-foreground">Account</h4>
              <Link to="/sign-in" className="text-muted-foreground transition-colors hover:text-foreground">Sign in</Link>
              <Link to="/sign-up" className="text-muted-foreground transition-colors hover:text-foreground">Sign up</Link>
              <Link to="/forgot-password" className="text-muted-foreground transition-colors hover:text-foreground">Forgot password</Link>
            </div>
          </div>
        </div>
        <div className="mx-auto mt-10 flex max-w-6xl flex-col items-center justify-between gap-2 border-t border-border/60 pt-6 text-xs text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} OutreachOS</span>
          <span>Built for senders who actually follow through.</span>
        </div>
      </footer>
    </div>
  );
}
