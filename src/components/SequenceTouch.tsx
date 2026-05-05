import type { SentMessage } from '../types';

interface TouchProps {
  label: string;
  touchIndex: number;
  subject: string;
  body: string;
  sent: SentMessage | undefined;
  sending: string | null;
  onCopy: (text: string) => void;
  copied: boolean;
  onSend: (touchIndex: number, mode: 'draft' | 'send') => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}

export function SequenceTouch({
  label,
  touchIndex,
  subject,
  body,
  sent,
  sending,
  onCopy,
  copied,
  onSend,
  disabled,
  disabledReason,
}: TouchProps) {
  const isSent = sent?.status === 'sent';
  const isDraft = sent?.status === 'draft';
  return (
    <div className="sequence-touch">
      <div className="sequence-touch-head">
        <span className="touch-label">
          {label}
          {isSent && <span className="sent-badge">sent</span>}
          {isDraft && <span className="sent-badge draft">draft created</span>}
        </span>
        <div className="touch-actions">
          <button type="button" className="link-button" onClick={() => onCopy(`Subject: ${subject}\n\n${body}`)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {!isSent && (
            <>
              <button
                type="button"
                className="btn-secondary tiny"
                disabled={!!sending || disabled}
                title={disabledReason}
                onClick={() => onSend(touchIndex, 'draft')}
              >
                {sending === `draft:${touchIndex}` ? 'Drafting…' : isDraft ? 'Recreate draft' : 'Save as Gmail draft'}
              </button>
              <button
                type="button"
                className="btn-primary tiny"
                disabled={!!sending || disabled}
                title={disabledReason}
                onClick={() => {
                  if (confirm(`Send this email now?\n\nSubject: ${subject}`)) onSend(touchIndex, 'send');
                }}
              >
                {sending === `send:${touchIndex}` ? 'Sending…' : 'Send now'}
              </button>
            </>
          )}
        </div>
      </div>
      <div className="sequence-subject">{subject}</div>
      <pre className="sequence-text">{body}</pre>
    </div>
  );
}
