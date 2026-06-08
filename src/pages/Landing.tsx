import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';

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

export function Landing() {
  return (
    <div className="ldg-page">
      <header className="ldg-nav">
        <div className="ldg-nav-inner">
          <Logo size={26} />
          <nav className="ldg-nav-links">
            <a href="#how">How it works</a>
            <a href="#pipeline">Pipeline</a>
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
          <p className="ldg-hero-kicker">Cold outreach, end to end</p>
          <h1 className="ldg-hero-title">
            One mission in.<br />
            <span className="ldg-hero-italic">Pipeline out.</span>
          </h1>
          <p className="ldg-hero-sub">
            Ranked targets, verified contacts, sourced evidence, and personalized drafts,
            sent from your Gmail with replies routed back to you. Reviewable at every step.
          </p>
          <div className="ldg-hero-cta">
            <Link to="/sign-up" className="ldg-btn ldg-btn-primary ldg-btn-lg">Start free</Link>
            <a href="#how" className="ldg-btn ldg-btn-ghost ldg-btn-lg">See how it works</a>
          </div>
          <p className="ldg-hero-fineprint">
            Runs on Google Gemini. Connect Gmail to send. Apollo is optional.
          </p>
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

        <section id="pipeline" className="ldg-section ldg-section-soft">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">The pipeline</span>
            <h2>Five agents, one click.</h2>
            <p className="ldg-section-sub">
              Click <strong>Run full pipeline</strong> on a mission and watch each stage fire
              in sequence. Every output is reviewable before it leaves your inbox.
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
              </li>
            ))}
          </ol>
        </section>

        <section id="modes" className="ldg-section">
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
            {MODES.map((m) => (
              <div key={m.key} className="ldg-mode-row">
                <dt>{m.title}</dt>
                <dd>{m.blurb}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="ldg-section ldg-section-soft">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">Why it is different</span>
            <h2>Vendor-neutral by default. Power-user when you want it.</h2>
          </div>
          <div className="ldg-feature-grid">
            {FEATURES.map((f) => (
              <div key={f.title} className="ldg-feature-row">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ldg-cta-section">
          <div className="ldg-cta-card">
            <h2>Stop tab-hopping. Start sending.</h2>
            <p>
              Replace the Apollo, RocketReach, LinkedIn, ChatGPT, Sheets, Gmail dance with
              one mission, one click, one inbox.
            </p>
            <Link to="/sign-up" className="ldg-btn ldg-btn-primary ldg-btn-lg">
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
