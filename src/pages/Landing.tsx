import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';

const MODES = [
  {
    key: 'sponsorship',
    title: 'Sponsorship',
    blurb: 'Get devtools, brands, and platforms to sponsor your event or community.',
    icon: '🎟',
  },
  {
    key: 'bd',
    title: 'BD / Partnerships',
    blurb: 'Land integration, co-marketing, and channel deals that move the needle.',
    icon: '🤝',
  },
  {
    key: 'internship',
    title: 'Internship / Job',
    blurb: 'Reach hiring managers with proof of fit, not yet another generic ask.',
    icon: '🎓',
  },
  {
    key: 'recruiting',
    title: 'Recruiting',
    blurb: 'Source senior candidates with messages tied to their actual work.',
    icon: '🧲',
  },
  {
    key: 'sales',
    title: 'Cold Sales',
    blurb: 'Book meetings off real intent signals — funding, hiring, launches.',
    icon: '⚡',
  },
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
    body: 'Pick a mode, describe what you’re sending, and who you want to reach. Add your LinkedIn and we auto-fill your bio, proof points, and tone.',
  },
  {
    step: '02',
    title: 'Agents do the legwork',
    body: 'Targeting, contact graph, evidence, and sequence agents run in one click. Apollo provides verified emails when configured; web search fills the gaps.',
  },
  {
    step: '03',
    title: 'Review, send, track',
    body: 'Approve drafts in your voice, send via Gmail, and watch the inbox classify replies — interested, not now, wrong person — with suggested responses.',
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
            <a href="#modes">Modes</a>
            <a href="#pipeline">Pipeline</a>
          </nav>
          <div className="ldg-nav-cta">
            <Link to="/sign-in" className="ldg-link">Sign in</Link>
            <Link to="/sign-up" className="ldg-btn ldg-btn-primary">
              Get started <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="ldg-hero">
          <div className="ldg-hero-eyebrow">
            <span className="ldg-pill">
              <span className="ldg-pill-dot" /> Apollo + LinkedIn personalization shipped
            </span>
          </div>
          <h1 className="ldg-hero-title">
            Cold outreach that <span className="ldg-grad-text">writes itself</span>.
          </h1>
          <p className="ldg-hero-sub">
            One mission in. Ranked targets, verified contacts, sourced evidence, and personalized drafts out — sent from your Gmail with replies routed back to you.
          </p>
          <div className="ldg-hero-cta">
            <Link to="/sign-up" className="ldg-btn ldg-btn-primary ldg-btn-lg">
              Start free <span aria-hidden>→</span>
            </Link>
            <a href="#how" className="ldg-btn ldg-btn-ghost ldg-btn-lg">
              See how it works
            </a>
          </div>
          <p className="ldg-hero-fineprint">
            Bring your own LLM key + Supabase + Gmail. Apollo is optional.
          </p>

          <div className="ldg-hero-glass" aria-hidden>
            <PipelineVisual />
          </div>
        </section>

        <section id="how" className="ldg-section">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">How it works</span>
            <h2>Mission in. Pipeline out. Three steps.</h2>
          </div>
          <div className="ldg-how-grid">
            {HOW.map((h) => (
              <article key={h.step} className="ldg-how-card">
                <span className="ldg-how-step">{h.step}</span>
                <h3>{h.title}</h3>
                <p>{h.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="pipeline" className="ldg-section ldg-section-soft">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">The pipeline</span>
            <h2>Five agents, one click.</h2>
            <p className="ldg-section-sub">
              Click <strong>Run full pipeline</strong> on a mission and watch each stage fire in sequence — targeting, contacts, evidence, drafts. Every output is reviewable before it leaves your inbox.
            </p>
          </div>
          <div className="ldg-pipeline-strip">
            {PIPELINE.map((s, i) => (
              <div key={s.label} className="ldg-pipeline-node">
                <div className="ldg-pipeline-dot">{i + 1}</div>
                <div className="ldg-pipeline-label">{s.label}</div>
                <div className="ldg-pipeline-detail">{s.detail}</div>
              </div>
            ))}
          </div>
        </section>

        <section id="modes" className="ldg-section">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">Built for any mission</span>
            <h2>Five modes. Same pipeline. Different angles.</h2>
            <p className="ldg-section-sub">
              The system prompt shifts so the agent surfaces sponsorship history, partnership surface area, hiring signals, candidate pitches, or pain points — depending on what you’re actually trying to do.
            </p>
          </div>
          <div className="ldg-modes-grid">
            {MODES.map((m) => (
              <div key={m.key} className="ldg-mode-card">
                <span className="ldg-mode-icon" aria-hidden>{m.icon}</span>
                <h3>{m.title}</h3>
                <p>{m.blurb}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="ldg-section ldg-section-soft">
          <div className="ldg-section-head">
            <span className="ldg-eyebrow">Why it’s different</span>
            <h2>Vendor-neutral by default. Power-user when you want it.</h2>
          </div>
          <div className="ldg-feature-grid">
            <FeatureCard
              title="Evidence-first personalization"
              body="Every line in every draft is anchored to a sourced bullet — funding round, recent launch, hiring signal — so personalization isn’t a Mad Lib."
            />
            <FeatureCard
              title="Apollo when you want it"
              body="Drop in an APOLLO_API_KEY and targeting + contact discovery upgrade to verified emails and firmographics. No key? Web search keeps things working."
            />
            <FeatureCard
              title="Gmail send + reply routing"
              body="Send through your own Gmail and the inbox cron classifies replies — interested, not now, wrong person — with a suggested response queued up."
            />
            <FeatureCard
              title="Your voice, every time"
              body="LinkedIn enrichment auto-fills your bio, proof points, and tone so drafts sound like you on day one — no copy-paste from old emails."
            />
          </div>
        </section>

        <section className="ldg-cta-section">
          <div className="ldg-cta-card">
            <h2>Stop tab-hopping. Start sending.</h2>
            <p>
              Replace the Apollo → RocketReach → LinkedIn → ChatGPT → Sheets → Gmail dance with one mission, one click, one inbox.
            </p>
            <Link to="/sign-up" className="ldg-btn ldg-btn-primary ldg-btn-lg">
              Create your account <span aria-hidden>→</span>
            </Link>
          </div>
        </section>
      </main>

      <footer className="ldg-footer">
        <div className="ldg-footer-inner">
          <div className="ldg-footer-brand">
            <Logo size={24} />
            <p>Agentic cold outreach, end-to-end.</p>
          </div>
          <div className="ldg-footer-cols">
            <div>
              <h4>Product</h4>
              <a href="#how">How it works</a>
              <a href="#modes">Modes</a>
              <a href="#pipeline">Pipeline</a>
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

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="ldg-feature-card">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function PipelineVisual() {
  const stages = ['Mission', 'Targets', 'Contacts', 'Drafts', 'Sent'];
  return (
    <div className="ldg-visual">
      <div className="ldg-visual-window">
        <div className="ldg-visual-titlebar">
          <span className="ldg-dot ldg-dot-r" />
          <span className="ldg-dot ldg-dot-y" />
          <span className="ldg-dot ldg-dot-g" />
          <span className="ldg-visual-title">mission · q1-sponsorship</span>
        </div>
        <div className="ldg-visual-body">
          <div className="ldg-visual-flow">
            {stages.map((s, i) => (
              <div key={s} className="ldg-visual-stage" style={{ animationDelay: `${i * 0.18}s` }}>
                <span className="ldg-visual-num">{i + 1}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
          <div className="ldg-visual-row">
            <span className="ldg-visual-tag tag-apollo">apollo</span>
            <span className="ldg-visual-tag tag-verified">verified</span>
            <span>Vercel · Head of DevRel · 95% confidence</span>
          </div>
          <div className="ldg-visual-row">
            <span className="ldg-visual-tag tag-apollo">apollo</span>
            <span className="ldg-visual-tag tag-verified">verified</span>
            <span>Linear · Head of Community · 91% confidence</span>
          </div>
          <div className="ldg-visual-row">
            <span className="ldg-visual-tag tag-web">web_search</span>
            <span className="ldg-visual-tag tag-likely">likely</span>
            <span>Resend · Head of DevRel · 84% confidence</span>
          </div>
          <div className="ldg-visual-draft">
            <div className="ldg-visual-draft-meta">
              <strong>Subject:</strong> Sponsoring Hack the North 2026?
            </div>
            <p>
              Hey — saw you sponsored React Conf. We hosted 1.4k attendees last year (60% senior CS) and have a tier that maps to your dev-marketing motion. Worth 15 min next week?
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
