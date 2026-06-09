import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';
import { BrowserFrame, PipelineMock, DraftMock, InboxMock } from '../components/AppMockups';
import { MountainHero } from '../components/MountainHero';

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

const FAQ = [
  { q: 'Do I need a data-provider subscription?', a: 'No. The agents research the open web to find high-fit companies and the right decision-makers, then verify contact details. Just connect Gmail and go.' },
  { q: 'How does it send email?', a: 'Through your own Gmail, over a secure connection. You approve each send, or enable auto-send with guardrails once you trust it.' },
  { q: 'Is it autonomous, or do I stay in control?', a: 'Reviewable by default: every draft waits for your approval. When you are ready, turn on auto-send, with reply-stop and a suppression list as guardrails.' },
  { q: 'Does it follow up?', a: 'Yes. Follow-ups are scheduled and sent on cadence, and stop automatically the moment someone replies or unsubscribes.' },
  { q: 'What does it run on?', a: 'Google Gemini powers the agents. Your data lives in your account; emails send from your Gmail.' },
];

export function Landing() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight * 0.7);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="cl-page">
      <header className={`cl-nav${scrolled ? ' cl-scrolled' : ''}`}>
        <div className="cl-nav-inner">
          <Logo size={26} variant={scrolled ? 'default' : 'mono-light'} />
          <nav className="cl-nav-links">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#modes">Modes</a>
            <a href="#faq">FAQ</a>
          </nav>
          <div className="cl-nav-cta">
            <Link to="/sign-in" className="cl-link">Sign in</Link>
            <Link to="/sign-up" className="cl-btn cl-btn-primary">Get started</Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero — full-bleed mountain scene */}
        <section className="cl-hero">
          <MountainHero className="cl-hero-bg" />
          <div className="cl-hero-inner">
            <span className="cl-pill cl-pill-onsky">Agentic cold outreach</span>
            <h1 className="cl-hero-title">
              Cold outreach that<br />writes and sends itself.
            </h1>
            <p className="cl-hero-sub">
              One mission in: a mode, an offer, an audience. OutreachOS researches the targets,
              finds the right people, sources the evidence, and drafts personalized emails, sent
              from your Gmail with replies routed back to you.
            </p>
            <div className="cl-hero-cta">
              <Link to="/sign-up" className="cl-btn cl-btn-onsky cl-btn-lg">Start free</Link>
              <a href="#how" className="cl-btn cl-btn-skyghost cl-btn-lg">See how it works</a>
            </div>
            <p className="cl-hero-note">Runs on Google Gemini. Connect Gmail to send.</p>
          </div>
        </section>

        {/* Features, alternating */}
        <section id="features" className="cl-features">
          <div className="cl-feature">
            <div className="cl-feature-copy">
              <span className="cl-eyebrow">Targeting</span>
              <h2>The right companies, ranked by why-now.</h2>
              <p>
                The targeting agent finds high-fit companies and scores each one on a real reason
                to reach out today: a funding round, a launch, a hiring signal. No scraping
                spreadsheets, no guessing.
              </p>
              <ul className="cl-feature-list">
                <li>Web research, ranked by fit and recency</li>
                <li>Verified emails and the actual decision-maker</li>
                <li>Evidence sourced per company, with citations</li>
              </ul>
            </div>
            <div className="cl-feature-shot cl-shot-a">
              <BrowserFrame url="app.outreachos.com/missions"><PipelineMock /></BrowserFrame>
            </div>
          </div>

          <div className="cl-feature cl-feature-rev">
            <div className="cl-feature-copy">
              <span className="cl-eyebrow">Drafts</span>
              <h2>Personalization with receipts.</h2>
              <p>
                Every line in every draft is anchored to a sourced bullet, so personalization is
                not a Mad Lib. The model cannot flatter what it has not read. You review, tweak,
                and send in your own voice.
              </p>
              <ul className="cl-feature-list">
                <li>Each claim tied to a citation</li>
                <li>Written in your tone, from your profile</li>
                <li>A 3-touch sequence, ready to send</li>
              </ul>
            </div>
            <div className="cl-feature-shot cl-shot-b">
              <BrowserFrame url="app.outreachos.com/draft"><DraftMock /></BrowserFrame>
            </div>
          </div>

          <div className="cl-feature">
            <div className="cl-feature-copy">
              <span className="cl-eyebrow">Inbox</span>
              <h2>Replies, sorted and answered.</h2>
              <p>
                Send through your Gmail and the inbox classifies every reply, interested, not now,
                wrong person, with a suggested response queued up. Follow-ups stop the moment
                someone writes back.
              </p>
              <ul className="cl-feature-list">
                <li>Replies classified automatically</li>
                <li>Suggested responses, ready to edit</li>
                <li>Follow-ups stop on reply or unsubscribe</li>
              </ul>
            </div>
            <div className="cl-feature-shot cl-shot-c">
              <BrowserFrame url="app.outreachos.com/inbox"><InboxMock /></BrowserFrame>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="cl-how">
          <div className="cl-section-head">
            <span className="cl-eyebrow">How it works</span>
            <h2>Mission in. Pipeline out. Three steps.</h2>
          </div>
          <div className="cl-how-grid">
            {HOW.map((h) => (
              <div key={h.step} className="cl-how-card">
                <span className="cl-how-num">{h.step}</span>
                <h3>{h.title}</h3>
                <p>{h.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Modes */}
        <section id="modes" className="cl-modes">
          <div className="cl-section-head">
            <span className="cl-eyebrow">Built for any mission</span>
            <h2>Five modes. Same pipeline. Different angles.</h2>
          </div>
          <div className="cl-modes-grid">
            {MODES.map((m) => (
              <div key={m.title} className="cl-mode">
                <h3>{m.title}</h3>
                <p>{m.blurb}</p>
              </div>
            ))}
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="cl-faq">
          <div className="cl-section-head">
            <span className="cl-eyebrow">FAQ</span>
            <h2>Questions, answered.</h2>
          </div>
          <div className="cl-faq-list">
            {FAQ.map((f) => (
              <details key={f.q} className="cl-faq-item">
                <summary>{f.q}<span className="cl-faq-mark" aria-hidden>+</span></summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="cl-cta">
          <div className="cl-cta-inner">
            <h2>Stop tab-hopping.<br />Start sending.</h2>
            <p>Replace the LinkedIn, ChatGPT, spreadsheets, and Gmail juggling with one mission, one click, one inbox.</p>
            <Link to="/sign-up" className="cl-btn cl-btn-ondark cl-btn-lg">Create your account</Link>
          </div>
        </section>
      </main>

      <footer className="cl-footer">
        <div className="cl-footer-inner">
          <div className="cl-footer-brand">
            <Logo size={24} />
            <p>Agentic cold outreach, end to end.</p>
          </div>
          <div className="cl-footer-cols">
            <div>
              <h4>Product</h4>
              <a href="#how">How it works</a>
              <a href="#features">Features</a>
              <a href="#modes">Modes</a>
              <a href="#faq">FAQ</a>
            </div>
            <div>
              <h4>Account</h4>
              <Link to="/sign-in">Sign in</Link>
              <Link to="/sign-up">Sign up</Link>
              <Link to="/forgot-password">Forgot password</Link>
            </div>
          </div>
        </div>
        <div className="cl-footer-bottom">
          <span>© {new Date().getFullYear()} OutreachOS</span>
          <span>Built for senders who actually follow through.</span>
        </div>
      </footer>
    </div>
  );
}
