// Stylized product mockups for the landing page, framed in a browser chrome.
// Pure CSS/markup (no real screenshots yet) representing the actual app views:
// the mission pipeline, the draft editor, and the reply inbox.

export function BrowserFrame({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <div className="cl-browser">
      <div className="cl-browser-bar">
        <span className="cl-browser-dots" aria-hidden>
          <i /><i /><i />
        </span>
        <span className="cl-browser-url">{url}</span>
      </div>
      <div className="cl-browser-body">{children}</div>
    </div>
  );
}

const TARGETS = [
  { name: 'Resend', why: 'Series B · hiring DevRel', score: 95 },
  { name: 'Linear', why: 'Launched Insights · community push', score: 91 },
  { name: 'Supabase', why: 'New AI features · dev events', score: 88 },
  { name: 'Clerk', why: 'Series B · expanding partnerships', score: 84 },
];

export function PipelineMock() {
  return (
    <div className="cl-mock cl-mock-pipeline">
      <div className="cl-mock-head">
        <span className="cl-mock-title">q1-sponsorship</span>
        <span className="cl-mock-chip cl-chip-run">running</span>
      </div>
      <ul className="cl-mock-targets">
        {TARGETS.map((t) => (
          <li key={t.name}>
            <div className="cl-mock-target-main">
              <span className="cl-mock-target-name">{t.name}</span>
              <span className="cl-mock-target-why">{t.why}</span>
            </div>
            <div className="cl-mock-score">
              <span className="cl-mock-score-bar"><span style={{ width: `${t.score}%` }} /></span>
              <span className="cl-mock-score-num">{t.score}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DraftMock() {
  return (
    <div className="cl-mock cl-mock-draft">
      <div className="cl-mock-draft-field"><span>To</span> jess@resend.com</div>
      <div className="cl-mock-draft-field"><span>Subject</span> Sponsoring our 2026 developer conference?</div>
      <div className="cl-mock-draft-body">
        <p>Hey Jess,</p>
        <p>
          Saw Resend <mark>closed Series B this March</mark> and{' '}
          <mark>is hiring its first developer-marketing lead</mark>. That same week, the team{' '}
          <mark>shipped Vue support</mark>, the exact framework crowd we host.
        </p>
        <p>Our conference drew 1,400+ engineers last year. Worth 15 minutes next week?</p>
      </div>
      <div className="cl-mock-draft-foot">
        <span className="cl-mock-chip cl-chip-ok">3 sources</span>
        <span className="cl-mock-send">Send</span>
      </div>
    </div>
  );
}

const REPLIES = [
  { from: 'Jess at Resend', snippet: 'Interesting, can you send tiers?', tag: 'Interested', tone: 'ok' },
  { from: 'Marco at Linear', snippet: 'Not this quarter, ping me in Q3.', tag: 'Not now', tone: 'warn' },
  { from: 'Dana at Clerk', snippet: 'I am not the right person for this.', tag: 'Wrong person', tone: 'muted' },
];

export function InboxMock() {
  return (
    <div className="cl-mock cl-mock-inbox">
      {REPLIES.map((r) => (
        <div key={r.from} className="cl-mock-reply">
          <div className="cl-mock-reply-main">
            <span className="cl-mock-reply-from">{r.from}</span>
            <span className="cl-mock-reply-snippet">{r.snippet}</span>
          </div>
          <span className={`cl-mock-chip cl-chip-${r.tone}`}>{r.tag}</span>
        </div>
      ))}
    </div>
  );
}
