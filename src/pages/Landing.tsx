import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { MountainScene, RidgeSilhouette, ContourField } from '../components/MountainScene';

const MODES = [
  { key: 'sponsorship', title: 'Sponsorship', blurb: 'Get devtools, brands, and platforms to sponsor your event or community.' },
  { key: 'bd', title: 'BD / Partnerships', blurb: 'Land integration, co-marketing, and channel deals that move the needle.' },
  { key: 'internship', title: 'Internship / Job', blurb: 'Reach hiring managers with proof of fit, not yet another generic ask.' },
  { key: 'recruiting', title: 'Recruiting', blurb: 'Source senior candidates with messages tied to their actual work.' },
  { key: 'sales', title: 'Cold Sales', blurb: 'Book meetings off real intent signals, funding, hiring, launches.' },
];

const PIPELINE = [
  { label: 'Mission', detail: 'Mode + offer + audience' },
  { label: 'Targets', detail: 'Apollo + web research, ranked' },
  { label: 'Contacts', detail: 'Verified emails, decision-makers' },
  { label: 'Evidence', detail: 'Sourced bullets per target' },
  { label: 'Drafts', detail: 'Personalized 3-touch sequence' },
  { label: 'Sent', detail: 'Gmail + reply tracking' },
];

const HOW = [
  {
    step: '01',
    title: 'Tell us the mission',
    body: 'Pick a mode, describe what you are sending, and who you want to reach. Add your LinkedIn and we auto-fill your bio, proof points, and tone.',
  },
  {
    step: '02',
    title: 'Agents do the legwork',
    body: 'Targeting, contact graph, evidence, and sequence agents run in one click. Apollo provides verified emails when configured; web search fills the gaps.',
  },
  {
    step: '03',
    title: 'Review, send, track',
    body: 'Approve drafts in your voice, send via Gmail, and watch the inbox classify replies (interested, not now, wrong person) with suggested responses.',
  },
];

const FEATURES = [
  {
    title: 'Evidence-first personalization',
    body: 'Every line in every draft is anchored to a sourced bullet (funding round, recent launch, hiring signal), so personalization is not a Mad Lib.',
  },
  {
    title: 'Apollo when you want it',
    body: 'Drop in an APOLLO_API_KEY and targeting + contact discovery upgrade to verified emails and firmographics. No key? Web search keeps things working.',
  },
  {
    title: 'Gmail send + reply routing',
    body: 'Send through your own Gmail. The inbox cron classifies replies (interested, not now, wrong person) with a suggested response queued up.',
  },
  {
    title: 'Your voice, every time',
    body: 'LinkedIn enrichment auto-fills your bio, proof points, and tone so drafts sound like you on day one, no copy-paste from old emails.',
  },
];

const TRACE = [
  { stage: 'TARGET', ok: 'ok', detail: 'Vercel · Resend · Linear · Supabase · Clerk · 3 more', meta: '8 ranked · 4.1s' },
  { stage: 'EVIDENCE', ok: 'ok', detail: 'Apollo firmographics + 12 sourced bullets per company', meta: 'grounded · 6.4s' },
  { stage: 'CONTACTS', ok: 'ok', detail: 'Head of DevRel · Director of Community · 91% avg confidence', meta: '14 verified · 3.8s' },
  { stage: 'SEQUENCE', ok: 'ok', detail: 'Subject + 3-touch body, threaded follow-ups scheduled', meta: '5 drafts · 5.7s' },
];

export function Landing() {
  return (
    <div className="ldg-page">
      <header className="ldg-nav">
        <div className="ldg-nav-inner">
          <Logo size={26} variant="mono-light" />
          <nav className="ldg-nav-links">
            <a href="#how">How it works</a>
            <a href="#trace">Live trace</a>
            <a href="#specimen">A real draft</a>
            <a href="#modes">Modes</a>
          </nav>
          <div className="ldg-nav-cta">
            <Link to="/sign-in" className="ldg-link">Sign in</Link>
            <Link to="/sign-up" className="ldg-btn ldg-btn-primary">Get started</Link>
          </div>
        </div>
      </header>

      <main>
        <section className="ldg-hero">
          <MountainScene className="ldg-scene" />
          <div className="ldg-hero-fade" aria-hidden />
          <div className="ldg-hero-grid">
            <p className="ldg-hero-meta">
              <span>Agentic cold outreach</span>
              <span className="ldg-hero-meta-sep" aria-hidden />
              <span>Apollo · LinkedIn · Gmail</span>
              <span className="ldg-hero-meta-sep" aria-hidden />
              <span className="ldg-hero-meta-tag">v1.0 shipping</span>
            </p>
            <h1 className="ldg-hero-title">
              One mission in.<br />
              <span className="ldg-hero-italic">Pipeline out.</span>
            </h1>
            <p className="ldg-hero-sub">
              Ranked targets, verified contacts, sourced evidence, and personalized drafts,
              sent from your Gmail with replies routed back to you. Reviewable at every step,
              autonomous once you trust it.
            </p>
            <div className="ldg-hero-cta">
              <Link to="/sign-up" className="ldg-btn ldg-btn-primary ldg-btn-lg">Start free</Link>
              <a href="#trace" className="ldg-btn ldg-btn-ghost ldg-btn-lg">Watch a real run</a>
            </div>
            <p className="ldg-hero-fineprint">
              Runs on Google Gemini. Connect Gmail to send. Apollo is optional.
            </p>
          </div>
        </section>

        <section id="trace" className="ldg-section ldg-trace-section">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">A real run</span>
            <h2>What you actually see, not a screenshot.</h2>
            <p className="ldg-section-sub">
              Each stage logs its inputs, citations, and latency. No glass mockups, no
              made-up dashboard chrome, this is the agent output your missions emit.
            </p>
          </div>
          <div className="ldg-trace">
            <div className="ldg-trace-head">
              <span className="ldg-trace-title">mission · q1-sponsorship</span>
              <span className="ldg-trace-status">RUNNING</span>
            </div>
            <ol className="ldg-trace-log">
              {TRACE.map((t, i) => (
                <li key={t.stage} className="ldg-trace-line" style={{ animationDelay: `${i * 0.12}s` }}>
                  <span className="ldg-trace-num">{String(i + 1).padStart(2, '0')}</span>
                  <span className="ldg-trace-stage">{t.stage}</span>
                  <span className="ldg-trace-ok" aria-label="ok">{t.ok}</span>
                  <span className="ldg-trace-detail">{t.detail}</span>
                  <span className="ldg-trace-meta">{t.meta}</span>
                </li>
              ))}
              <li className="ldg-trace-line ldg-trace-line-final" style={{ animationDelay: `${TRACE.length * 0.12}s` }}>
                <span className="ldg-trace-num">{String(TRACE.length + 1).padStart(2, '0')}</span>
                <span className="ldg-trace-stage">REVIEW</span>
                <span className="ldg-trace-ok ldg-trace-ok-wait">queued</span>
                <span className="ldg-trace-detail">Awaiting your approval before send.</span>
                <span className="ldg-trace-meta">you</span>
              </li>
            </ol>
          </div>
        </section>

        <section id="how" className="ldg-section">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">How it works</span>
            <h2>Mission in. Pipeline out. Three steps.</h2>
          </div>
          <ol className="ldg-how-list">
            {HOW.map((h) => (
              <li key={h.step} className="ldg-how-item">
                <span className="ldg-how-step">{h.step}</span>
                <div>
                  <h3>{h.title}</h3>
                  <p>{h.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section id="specimen" className="ldg-section ldg-section-soft">
          <ContourField className="ldg-contour ldg-contour-soft" />
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">A specimen draft</span>
            <h2>Personalization with receipts.</h2>
            <p className="ldg-section-sub">
              Every claim in the email is anchored to a sourced bullet. The model cannot
              flatter what it has not read. Hover the highlights to see the citation.
            </p>
          </div>
          <article className="ldg-specimen">
            <header className="ldg-specimen-head">
              <div>
                <span className="ldg-specimen-from">to_</span>
                <span className="ldg-specimen-addr">jess@resend.com</span>
              </div>
              <div className="ldg-specimen-subject">
                <span className="ldg-specimen-from">re_</span>
                Sponsoring Hack the North 2026?
              </div>
            </header>
            <div className="ldg-specimen-body">
              <p>Hey Jess,</p>
              <p>
                Saw Resend{' '}
                <mark className="ldg-cite" data-cite="Funding announcement · 2025-03">
                  closed Series B this March
                </mark>{' '}
                and{' '}
                <mark className="ldg-cite" data-cite="Job board · open as of 2026-05">
                  is hiring its first developer-marketing lead
                </mark>
                . That same week, the team{' '}
                <mark className="ldg-cite" data-cite="Twitter @resend · 2026-05-14">
                  shipped Vue support
                </mark>{' '}
                — the framework crowd we host most.
              </p>
              <p>
                We hosted{' '}
                <mark className="ldg-cite" data-cite="Hack the North recap deck · pg.12">
                  1,418 attendees last year (60% senior CS)
                </mark>
                , and have a tier that maps to the dev-marketing motion you are
                building. Worth 15 min next week?
              </p>
              <p className="ldg-specimen-sign">— Daniel</p>
            </div>
            <aside className="ldg-specimen-margin" aria-label="Sourced citations">
              <p className="ldg-specimen-margin-head">Sources</p>
              <ol>
                <li><span>01</span> Series B announcement · TechCrunch · 2025-03</li>
                <li><span>02</span> Public job board · Resend careers · open</li>
                <li><span>03</span> @resend tweet · Vue support shipped</li>
                <li><span>04</span> HtN 2025 recap deck · pg.12</li>
              </ol>
            </aside>
          </article>
        </section>

        <section id="pipeline" className="ldg-section ldg-band-dark">
          <ContourField className="ldg-contour ldg-contour-dark" />
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">The pipeline</span>
            <h2>Five agents, one click.</h2>
            <p className="ldg-section-sub">
              Click <strong>Run full pipeline</strong> on a mission and watch each stage
              fire in sequence. Every output is reviewable before it leaves your inbox.
            </p>
          </div>
          <ol className="ldg-pipeline-flow">
            {PIPELINE.map((s, i) => (
              <li key={s.label} className="ldg-pipeline-step">
                <span className="ldg-pipeline-num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div className="ldg-pipeline-label">{s.label}</div>
                  <div className="ldg-pipeline-detail">{s.detail}</div>
                </div>
                {i < PIPELINE.length - 1 && (
                  <span className="ldg-pipeline-arrow" aria-hidden>↓</span>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section id="modes" className="ldg-section ldg-section-soft">
          <ContourField className="ldg-contour ldg-contour-soft" />
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">Built for any mission</span>
            <h2>Five modes. Same pipeline. Different angles.</h2>
            <p className="ldg-section-sub">
              The system prompt shifts so the agent surfaces sponsorship history, partnership
              surface area, hiring signals, candidate pitches, or pain points, depending on
              what you are actually trying to do.
            </p>
          </div>
          <dl className="ldg-modes-table">
            {MODES.map((m, i) => (
              <div key={m.key} className="ldg-mode-row">
                <dt>
                  <span className="ldg-mode-num">{String(i + 1).padStart(2, '0')}</span>
                  {m.title}
                </dt>
                <dd>{m.blurb}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="ldg-section">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">Why it is different</span>
            <h2>Vendor-neutral by default. Power-user when you want it.</h2>
          </div>
          <div className="ldg-feature-grid">
            {FEATURES.map((f, i) => (
              <div key={f.title} className="ldg-feature-row">
                <span className="ldg-feature-num">{String(i + 1).padStart(2, '0')}</span>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ldg-cta-section">
          <div className="ldg-cta-card">
            <RidgeSilhouette className="ldg-cta-ridge" />
            <span className="ldg-cta-eyebrow">Start sending</span>
            <h2>
              Stop tab-hopping.<br />
              <span className="ldg-hero-italic">Start sending.</span>
            </h2>
            <p>
              Replace the Apollo, RocketReach, LinkedIn, ChatGPT, Sheets, Gmail dance with
              one mission, one click, one inbox.
            </p>
            <Link to="/sign-up" className="ldg-btn ldg-btn-cta ldg-btn-lg">
              Create your account
            </Link>
          </div>
        </section>
      </main>

      <footer className="ldg-footer">
        <div className="ldg-footer-inner">
          <div className="ldg-footer-brand">
            <Logo size={24} />
            <p>Agentic cold outreach, end to end.</p>
          </div>
          <div className="ldg-footer-cols">
            <div>
              <h4>Product</h4>
              <a href="#how">How it works</a>
              <a href="#trace">Live trace</a>
              <a href="#pipeline">Pipeline</a>
              <a href="#modes">Modes</a>
            </div>
            <div>
              <h4>Account</h4>
              <Link to="/sign-in">Sign in</Link>
              <Link to="/sign-up">Sign up</Link>
              <Link to="/forgot-password">Forgot password</Link>
            </div>
          </div>
        </div>
        <div className="ldg-footer-bottom">
          <span>© {new Date().getFullYear()} OutreachOS</span>
          <span className="ldg-footer-tag">Built for senders who actually follow through.</span>
        </div>
      </footer>
    </div>
  );
}
