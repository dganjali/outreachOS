import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from './Logo';

interface Props {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthShell({ title, subtitle, children, footer }: Props) {
  return (
    <div className="auth-shell">
      <aside className="auth-marketing" aria-hidden="true">
        <div className="auth-marketing-top">
          <Logo size={26} variant="mono-light" to="/" />
        </div>
        <div className="auth-marketing-mid">
          <h2>One mission in. A ready-to-send pipeline out.</h2>
          <p>
            OutreachOS replaces the LinkedIn → ChatGPT → Sheets → Gmail dance with five agents that hand you ranked targets, verified contacts, sourced evidence, and personalized drafts, every line anchored in something real.
          </p>
          <ul className="auth-marketing-bullets">
            <li>Web research, ranked by recent “why now” signals</li>
            <li>Verified emails and decision-makers per target</li>
            <li>Drafts in your voice, sent through your Gmail</li>
            <li>Inbox routes replies back with classification + suggestions</li>
          </ul>
        </div>
        <div className="auth-marketing-bottom">
          Trouble signing in? <Link to="/forgot-password">Reset your password</Link>.
        </div>
      </aside>

      <section className="auth-form-panel">
        <div className="auth-form-inner">
          <div className="auth-form-mobile-brand">
            <Logo size={26} />
          </div>
          <h1>{title}</h1>
          {subtitle && <p className="auth-sub">{subtitle}</p>}
          {children}
          {footer && <div className="auth-form-footer">{footer}</div>}
        </div>
      </section>
    </div>
  );
}
