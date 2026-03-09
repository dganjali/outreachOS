import { Link } from 'react-router-dom';

export function Landing() {
  return (
    <div className="public-page">
      <header className="landing-header">
        <nav>
          <Link to="/">OutreachOS</Link>
          <Link to="/sign-in">Sign In</Link>
          <Link to="/sign-up">Sign Up</Link>
        </nav>
      </header>

      <main>
        <section className="landing-hero" aria-label="Hero">
          <h1>OutreachOS</h1>
          <p>Agentic cold outreach, end-to-end.</p>
          <Link to="/sign-up" className="btn-primary">Get started</Link>
        </section>

        <section className="landing-section" aria-label="How it works">
          <h2>How it works</h2>
          <ol>
            <li>Create a mission — define your goal and who you want to reach.</li>
            <li>Add or discover targets and contacts.</li>
            <li>Generate personalized email drafts from your profile and proof points.</li>
            <li>Track replies and update your pipeline.</li>
          </ol>
        </section>

        <section className="landing-section" aria-label="Features">
          <h2>Features</h2>
          <ul>
            <li>Mission-based campaigns (sponsorships, BD, recruiting, internships)</li>
            <li>Evidence-first personalization</li>
            <li>Email draft generation with your voice</li>
            <li>Targets, contacts, and reply tracking</li>
            <li>Profile and proof points for consistent outreach</li>
          </ul>
        </section>

        <section className="landing-cta" aria-label="Call to action">
          <h2>Ready to run outreach that actually follows through?</h2>
          <Link to="/sign-up" className="btn-primary">Create account</Link>
        </section>
      </main>

      <footer className="landing-footer">
        <p>OutreachOS — Agentic Cold Outreach, End-to-End</p>
        <Link to="/sign-in">Sign In</Link>
        <Link to="/sign-up">Sign Up</Link>
      </footer>
    </div>
  );
}
