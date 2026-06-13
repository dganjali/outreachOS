import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Target, FileText, Inbox as InboxIcon, Check } from 'lucide-react';
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
            <a href="#pricing" className="transition-colors hover:text-foreground">Pricing</a>
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
        <section className="relative isolate overflow-hidden px-5 pb-12 pt-16 md:pt-20">
          {/* atmospheric background — near-black with a restrained green, particle terrain below */}
          <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
            {/* base gradient: black at the top, easing to a very dark green-slate near the terrain */}
            <div className="absolute inset-0 bg-[linear-gradient(180deg,hsl(220_30%_4%)_0%,hsl(216_24%_5%)_34%,hsl(200_18%_8%)_60%,hsl(168_22%_10%)_84%,hsl(164_26%_8%)_100%)]" />

            {/* soft radial halo behind the headline — white with a whisper of green, low opacity */}
            <div className="absolute left-1/2 top-[30%] h-[40rem] w-[58rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,hsl(150_30%_82%/0.10),hsl(155_40%_55%/0.05)_42%,transparent_70%)] blur-[60px]" />

            {/* low horizon glow — subtle green light where the terrain meets the dark */}
            <div className="absolute bottom-[30%] left-1/2 h-72 w-[88rem] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(ellipse_at_center,hsl(150_55%_60%/0.16),hsl(152_50%_45%/0.07)_46%,transparent_72%)] blur-[60px]" />

            {/* generative particle terrain (three.js) — white dots with green crest highlights */}
            <GenerativeMountains className="absolute inset-x-0 bottom-0 h-[86%] w-full" />

            {/* faint grid near the top */}
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  'linear-gradient(to right, hsl(160 30% 60% / 0.045) 1px, transparent 1px), linear-gradient(to bottom, hsl(160 30% 60% / 0.045) 1px, transparent 1px)',
                backgroundSize: '60px 60px',
                maskImage: 'radial-gradient(110% 45% at 50% 0%, #000 25%, transparent 70%)',
                WebkitMaskImage: 'radial-gradient(110% 45% at 50% 0%, #000 25%, transparent 70%)',
              }}
            />
            {/* film grain */}
            <div className="bg-grain absolute inset-0 opacity-[0.05] mix-blend-soft-light" />
            {/* darken under the nav so the logo/links stay crisp */}
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background to-transparent" />
            {/* clean fade into the next section at the bottom */}
            <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
            {/* gentle side vignette */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_75%_115%_at_50%_45%,transparent_68%,hsl(var(--background))_100%)]" />
          </div>

          <div className="mx-auto max-w-3xl text-center animate-fade-in">
            <h1 className="text-balance font-display text-5xl font-bold leading-[1.05] tracking-tight text-wash md:text-7xl">
              Cold outreach that writes and sends itself.
            </h1>
            <p className="mx-auto mt-5 max-w-3xl text-pretty text-lg leading-relaxed text-muted-foreground">
              Agentic cold outreach: OutreachOS finds the right companies, writes personalized emails
              backed by real buying signals, and sends them from your Gmail.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="btn-glow gap-2 border-0 px-6 font-semibold text-primary-foreground">
                <Link to="/sign-up">
                  Start free <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="border-border bg-secondary/30 px-6 font-medium backdrop-blur">
                <a href="#how">See how it works</a>
              </Button>
            </div>
            <p className="mt-4 text-sm text-muted-foreground/80">Runs on Google Gemini. Connect Gmail to send.</p>
          </div>

          {/* hero product shot */}
          <div className="relative mx-auto mt-5 max-w-5xl animate-fade-in">
            <div aria-hidden className="pointer-events-none absolute -inset-x-10 -top-8 bottom-0 -z-10 rounded-[2rem] bg-primary/10 blur-[80px]" />
            {/* gradient ring frame */}
            <div className="rounded-2xl bg-gradient-to-b from-primary/30 via-border/50 to-transparent p-px shadow-[0_50px_140px_-40px_rgba(0,0,0,0.95)]">
              <BrowserFrame url="app.outreachos.com/missions" bodyClassName="p-0">
                <HeroAppMock />
              </BrowserFrame>
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

        {/* Pricing */}
        <section id="pricing" className="mx-auto max-w-6xl px-5 py-24 md:px-8">
          <SectionHead eyebrow="Pricing" title="Start free. Scale when it works." />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {PLAN_ORDER.map((id) => {
              const plan = PLANS[id];
              const featured = id === 'pro';
              return (
                <div
                  key={id}
                  className={cn(
                    'relative flex flex-col rounded-2xl border p-6',
                    featured
                      ? 'border-primary/60 bg-primary/[0.06] shadow-[0_0_70px_-25px_hsl(var(--primary)/0.6)]'
                      : 'border-border bg-card'
                  )}
                >
                  {featured && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-3 py-0.5 text-[11px] font-semibold text-primary-foreground">
                      Most popular
                    </span>
                  )}
                  <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
                  <div className="mt-3 flex items-baseline gap-1">
                    {plan.priceMonthly === 0 ? (
                      <span className="font-display text-4xl font-bold text-wash">Free</span>
                    ) : (
                      <>
                        <span className="font-display text-4xl font-bold text-wash">${plan.priceMonthly}</span>
                        <span className="text-sm text-muted-foreground">/mo</span>
                      </>
                    )}
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{plan.blurb}</p>
                  <ul className="mb-8 mt-6 flex flex-col gap-3">
                    {plan.features.map((feat) => (
                      <li key={feat} className="flex items-start gap-2.5 text-sm text-foreground/90">
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                          <Check className="h-2.5 w-2.5" />
                        </span>
                        {feat}
                      </li>
                    ))}
                  </ul>
                  <Button
                    asChild
                    size="sm"
                    variant={featured ? 'default' : 'outline'}
                    className={cn(
                      'mt-auto w-full font-semibold',
                      featured ? 'btn-glow border-0 text-primary-foreground' : 'border-border'
                    )}
                  >
                    <Link to="/sign-up">{plan.priceMonthly === 0 ? 'Start free' : `Choose ${plan.name}`}</Link>
                  </Button>
                </div>
              );
            })}
          </div>
          <p className="mx-auto mt-8 max-w-xl text-center text-sm text-muted-foreground/80">
            Every plan runs the full agent pipeline. Pick a plan after you sign up — upgrade, downgrade, or cancel
            anytime from Settings.
          </p>
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
              <a href="#pricing" className="text-muted-foreground transition-colors hover:text-foreground">Pricing</a>
              <a href="#faq" className="text-muted-foreground transition-colors hover:text-foreground">FAQ</a>
            </div>
            <div className="flex flex-col gap-3 text-sm">
              <h4 className="font-semibold text-foreground">Account</h4>
              <Link to="/sign-in" className="text-muted-foreground transition-colors hover:text-foreground">Sign in</Link>
              <Link to="/sign-up" className="text-muted-foreground transition-colors hover:text-foreground">Sign up</Link>
              <Link to="/forgot-password" className="text-muted-foreground transition-colors hover:text-foreground">Forgot password</Link>
            </div>
            <div>
              <h4>Legal</h4>
              <Link to="/privacy">Privacy</Link>
              <Link to="/terms">Terms</Link>
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
