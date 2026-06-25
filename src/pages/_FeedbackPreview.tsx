// TEMP preview harness for verifying restyled components on the dark theme.
// Mounted at a public route (/feedback-preview) so the browser preview can
// screenshot it without Firebase auth. DELETE this file + its route after use.
import { Sparkles, Lock, Undo2, Pencil } from 'lucide-react';

const CHIPS = ['Shorter', 'Warmer', 'More direct', 'Stronger CTA', 'Fix grammar'];

export function FeedbackPreview() {
  return (
    <div className="app-canvas" style={{ minHeight: '100vh', padding: '2rem' }}>
      <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>Mission brief — view (editable)</h2>
        <section className="mission-overview-card">
          <button type="button" className="mission-overview-edit-btn"><Pencil size={13} aria-hidden /> Edit</button>
          <div className="mission-overview-grid">
            <div className="mission-overview-row"><strong>Offer</strong><span>Summer 2026 SWE co-op — full-stack, available May–Aug.</span></div>
            <div className="mission-overview-row"><strong>Audience</strong><span>Seed–Series B startups hiring engineers in Toronto.</span></div>
            <div className="mission-overview-row"><strong>Location</strong><span>Toronto, Canada</span></div>
            <div className="mission-overview-row"><strong>Notes</strong><span className="mission-overview-notes">Paused until August — focus post-Series A only.</span></div>
          </div>
        </section>

        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>Voice cards — inline rename (#14)</h2>
        <div className="me-personalization">
          <div className="me-voice-grid">
            <div className="me-voice-card-wrap">
              <button type="button" className="me-voice-card">
                <div className="me-voice-card-top"><span className="me-voice-name">Recruiting voice</span></div>
                <p className="me-voice-summary">Warm, concise, founder-to-founder tone.</p>
                <div className="me-voice-status"><span className="me-voice-tag is-ready"><Pencil size={12} /> Calibrated</span></div>
              </button>
              <button type="button" className="me-voice-rename" title="Rename voice"><Pencil size={13} /></button>
            </div>
            <div className="me-voice-card-wrap">
              <div className="me-voice-card me-voice-card-editing">
                <input className="me-voice-name-input" defaultValue="hjk" aria-label="Voice name" />
                <span className="me-voice-rename-hint">Enter to save · Esc to cancel</span>
              </div>
            </div>
          </div>
        </div>

        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>Loading skeleton — active missions (#15)</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[0, 1].map((i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton-card-row">
                <span className="app-skeleton" style={{ height: 16, width: 160, borderRadius: 6 }} />
                <span className="app-skeleton" style={{ marginLeft: 'auto', height: 20, width: 64, borderRadius: 999 }} />
              </div>
              <span className="app-skeleton" style={{ height: 10, width: '100%', borderRadius: 999 }} />
              <div className="skeleton-card-row">
                <span className="app-skeleton" style={{ height: 12, width: 80, borderRadius: 6 }} />
                <span className="app-skeleton" style={{ height: 12, width: 64, borderRadius: 6 }} />
                <span className="app-skeleton" style={{ height: 12, width: 64, borderRadius: 6 }} />
              </div>
            </div>
          ))}
        </div>

        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>Evidence signal tags (#19)</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {['funding', 'hiring', 'launch', 'sponsorship', 'partnership', 'leadership', 'press', 'blog', 'talk', 'other'].map((s) => (
            <span key={s} className="signal-pill" data-signal={s}>{s}</span>
          ))}
        </div>

        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>Email — no verified address (#8)</h2>
        <div className="email-override">
          <span className="email-override-label">Recipient email — no verified address (pattern suggests first@acme.com)</span>
          <div className="email-override-row">
            <input type="email" defaultValue="jordan@acme.com" placeholder="contact@company.com" />
            <button type="button" className="btn-secondary">Save to contact</button>
          </div>
          <p className="email-override-hint">
            Add an email to enable sending. <strong>Save to contact</strong> reuses it for every email to this person;
            otherwise it applies to this send only.
          </p>
        </div>

        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>Target controls — status + remove (#9)</h2>
        <div className="target-content-head" style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div className="target-content-controls">
            <label className="target-status-control">
              <span className="target-status-label">Status</span>
              <select defaultValue="suggested">
                <option value="suggested">Suggested</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="contacted">Contacted</option>
              </select>
            </label>
            <span className="target-controls-sep" aria-hidden />
            <button type="button" className="link-button target-delete" aria-label="Remove">×</button>
          </div>
        </div>
        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>AI Assist — enabled</h2>
        <div className="email-card">
          <div className="email-card-edit">
            <div className="email-edit-toolbar">
              <span className="email-edit-toolbar-title">Editing draft</span>
              <div className="email-edit-toolbar-actions">
                <button type="button" className="link-button">Cancel</button>
                <button type="button" className="btn-send">Save changes</button>
              </div>
            </div>
            <label className="email-field-label">Subject</label>
            <input className="reply-subject-input" defaultValue="Summer 2026 coop — quick chat?" />
            <label className="email-field-label">Message</label>
            <textarea
              className="reply-body-input"
              rows={6}
              defaultValue={"Noticed you're actively hiring engineering teams to scale the product.\n\nI'm looking for a summer 2026 coop and would be interested in learning if there's an opportunity to contribute.\n\nWould you be open to a brief chat next week to discuss?\n\nBest,\nDaniel Ganjali"}
            />
            {/* mirrors AiAssist (enabled) markup */}
            <div className="ai-assist">
              <div className="ai-assist-head">
                <Sparkles size={14} aria-hidden />
                <span>AI assist</span>
              </div>
              <div className="ai-assist-chips">
                {CHIPS.map((c) => (
                  <button key={c} type="button" className="ai-chip">{c}</button>
                ))}
              </div>
              <div className="ai-assist-custom">
                <input className="reply-subject-input" placeholder="Or tell the AI what to change…" />
                <button type="button" className="ai-assist-rewrite">Rewrite</button>
              </div>
              <div className="ai-assist-note">
                <Sparkles size={13} aria-hidden />
                <span>Tightened the opener and made the ask more specific.</span>
                <button type="button" className="ai-assist-undo">
                  <Undo2 size={12} aria-hidden /> Undo
                </button>
              </div>
            </div>
          </div>
        </div>

        <h2 style={{ color: 'var(--text)', fontWeight: 700 }}>AI Assist — locked (free tier)</h2>
        <div className="email-card">
          <div className="email-card-edit">
            <div className="ai-assist ai-assist-locked">
              <div className="ai-assist-lockhead">
                <Sparkles size={15} aria-hidden />
                <span>AI rewrite &amp; feedback</span>
                <span className="ai-assist-badge">Pro</span>
              </div>
              <p className="ai-assist-lockcopy">
                Rewrite for tone, length, or a stronger ask in one click — with a note on what changed.
              </p>
              <span className="ai-assist-upgrade">
                <Lock size={13} aria-hidden /> Upgrade to unlock
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
