// Privacy Policy and Terms of Service. These pages exist primarily to satisfy
// Google OAuth verification (the consent screen links here) and to be honest
// with users about what the app does with their data. They are intentionally
// plain, public, and unauthenticated. Not legal advice — have counsel review
// before relying on these commercially.

import { Link } from 'react-router-dom';
import { Logo } from '../components/Logo';

const COMPANY = 'OutreachOS';
const DOMAIN = 'outreach-os.ca';
const CONTACT = 'danielganjali09@gmail.com';
const UPDATED = 'June 11, 2026';

function LegalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="legal-page">
      <header className="legal-top">
        <Link to="/" className="legal-home" aria-label="Back to home">
          <Logo size={24} />
        </Link>
        <nav className="legal-nav">
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
      </header>
      <main className="legal-body">
        <h1>{title}</h1>
        <p className="legal-updated">Last updated: {UPDATED}</p>
        {children}
      </main>
      <footer className="legal-foot">
        <span>© {new Date().getFullYear()} {COMPANY}</span>
        <Link to="/">Back to home</Link>
      </footer>
    </div>
  );
}

export function Privacy() {
  return (
    <LegalShell title="Privacy Policy">
      <p>
        {COMPANY} (&ldquo;we,&rdquo; &ldquo;us&rdquo;) operates the agentic cold-outreach
        application at {DOMAIN}. This policy explains what data we collect, how we use it, and
        the choices you have. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Information we collect</h2>
      <ul>
        <li>
          <strong>Account data.</strong> The email address and password you use to create an
          account, and the profile details you provide (name, role, bio, proof points).
        </li>
        <li>
          <strong>Mission content.</strong> The campaigns, target companies, contacts, evidence,
          and email drafts you create or that the app generates on your behalf.
        </li>
        <li>
          <strong>Google account data.</strong> When you connect Gmail, we receive an OAuth token
          and your Google account email address. See the section below.
        </li>
      </ul>

      <h2>How we use Google user data</h2>
      <p>
        We request the <code>gmail.send</code> scope and your Google account email
        (<code>userinfo.email</code>) for a single purpose: <strong>to send the outreach emails
        you compose and approve, from your own Gmail account,</strong> and to display which
        account is connected. We do <strong>not</strong> read, search, or store the contents of
        your mailbox, and we do not request read or modify access.
      </p>

      <h2>Limited Use disclosure</h2>
      <p>
        {COMPANY}&rsquo;s use and transfer of information received from Google APIs adheres to the{' '}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noreferrer"
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Specifically, we do not use Google user data for
        advertising, we do not sell it, we do not transfer it to third parties except as needed to
        provide or improve the app&rsquo;s send feature (or as required by law), and we do not allow
        humans to read it except with your explicit consent, to comply with law, or for security.
      </p>

      <h2>Where your data lives</h2>
      <p>
        Account, profile, and mission data are stored in our database (MongoDB Atlas). OAuth tokens
        are encrypted at rest. Email is sent through Google&rsquo;s Gmail API. We use third-party AI
        providers to draft and analyze outreach content; only the content needed for a given task is
        sent to them, and they are not permitted to train on your data.
      </p>

      <h2>Sharing</h2>
      <p>
        We do not sell your data. We share it only with infrastructure subprocessors that run the
        service (cloud hosting, database, email delivery, AI drafting) and only as needed to operate
        the app, or when required by law.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>Disconnect Gmail at any time in the app; this revokes our access token.</li>
        <li>
          Revoke access directly at{' '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
            your Google Account permissions
          </a>
          .
        </li>
        <li>
          Request deletion of your account and associated data by emailing{' '}
          <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
        </li>
      </ul>

      <h2>Retention</h2>
      <p>
        We keep your data for as long as your account is active. When you delete your account, we
        delete your personal data and revoke stored tokens within a reasonable period, except where
        retention is required by law.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy; material changes will be reflected by the &ldquo;Last
        updated&rdquo; date above. Continued use after a change means you accept the updated policy.
      </p>
    </LegalShell>
  );
}

export function Terms() {
  return (
    <LegalShell title="Terms of Service">
      <p>
        These terms govern your use of {COMPANY} at {DOMAIN}. By creating an account or using the
        app, you agree to them. If you do not agree, do not use the service.
      </p>

      <h2>The service</h2>
      <p>
        {COMPANY} helps you research outreach targets and draft and send personalized emails from
        your own connected Gmail account. You are responsible for the content you send and for
        complying with all applicable laws.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>
          You will comply with anti-spam laws (including CAN-SPAM, CASL, and GDPR where applicable),
          and with Google&rsquo;s and Gmail&rsquo;s terms and sending limits.
        </li>
        <li>You will not send unlawful, deceptive, harassing, or bulk unsolicited messages.</li>
        <li>You will honor opt-out and unsubscribe requests promptly.</li>
        <li>You will not use the service to impersonate others or send on accounts you don&rsquo;t own.</li>
      </ul>

      <h2>Your account</h2>
      <p>
        You are responsible for safeguarding your credentials and for all activity under your
        account. Notify us promptly of any unauthorized use.
      </p>

      <h2>Your content</h2>
      <p>
        You retain ownership of the content you create. You grant us a limited license to process it
        solely to operate the service for you (for example, to generate drafts and send email on
        your instruction).
      </p>

      <h2>Disclaimers and liability</h2>
      <p>
        The service is provided &ldquo;as is,&rdquo; without warranties of any kind. To the maximum
        extent permitted by law, {COMPANY} is not liable for indirect, incidental, or consequential
        damages, or for outcomes of the outreach you choose to send.
      </p>

      <h2>Termination</h2>
      <p>
        You may stop using the service and delete your account at any time. We may suspend or
        terminate access for violations of these terms or to protect the service or its users.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalShell>
  );
}
