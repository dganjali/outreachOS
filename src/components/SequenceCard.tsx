import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { gmail } from '../lib/api';
import { SequenceTouch } from './SequenceTouch';
import type { Contact, EmailSequence, SentMessage } from '../types';

export function SequenceCard({ sequence, contact }: { sequence: EmailSequence; contact: Contact }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<Record<number, SentMessage | undefined>>({});
  const [overrideEmail, setOverrideEmail] = useState('');
  const [needsEmail, setNeedsEmail] = useState(false);

  useEffect(() => {
    supabase
      .from('sent_messages')
      .select('*')
      .eq('sequence_id', sequence.id)
      .then(({ data }) => {
        const map: Record<number, SentMessage | undefined> = {};
        for (const m of (data ?? []) as SentMessage[]) map[m.touch_index] = m;
        setSentMessages(map);
      });
  }, [sequence.id]);

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  async function doSend(touchIndex: number, mode: 'draft' | 'send') {
    setSendErr(null);
    setSending(`${mode}:${touchIndex}`);
    try {
      const r = await gmail.send(sequence.id, touchIndex, mode, overrideEmail || undefined);
      setSentMessages((s) => ({
        ...s,
        [touchIndex]: {
          ...(s[touchIndex] as SentMessage | undefined),
          id: r.sent_message_id,
          touch_index: touchIndex,
          status: mode === 'send' ? 'sent' : 'draft',
          gmail_message_id: r.gmail_message_id,
          gmail_thread_id: r.gmail_thread_id,
          gmail_draft_id: r.gmail_draft_id ?? null,
          sent_at: mode === 'send' ? new Date().toISOString() : null,
        } as SentMessage,
      }));
      setNeedsEmail(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      setSendErr(msg);
      if (msg.includes('no_recipient_email') || msg.includes('Provide to_override')) setNeedsEmail(true);
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="sequence-card">
      <button type="button" className="sequence-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Email sequence
        {sequence.primary_angle && <span className="angle-pill">{sequence.primary_angle}</span>}
      </button>
      {open && (
        <div className="sequence-body">
          {needsEmail && (
            <div className="email-override">
              <label>
                Recipient email (not in our records)
                <input
                  type="email"
                  value={overrideEmail}
                  onChange={(e) => setOverrideEmail(e.target.value)}
                  placeholder="contact@company.com"
                />
              </label>
            </div>
          )}
          {sendErr && <div className="banner-error">{sendErr}</div>}

          <SequenceTouch
            label="Initial"
            touchIndex={0}
            subject={sequence.subject}
            body={sequence.body}
            sent={sentMessages[0]}
            sending={sending}
            onCopy={(t) => copy('initial', t)}
            copied={copied === 'initial'}
            onSend={doSend}
            disabled={!contact.email && !overrideEmail}
          />
          {sequence.followups.map((f, i) => {
            const idx = i + 1;
            return (
              <SequenceTouch
                key={i}
                label={`Follow-up ${i + 1} · day +${f.wait_days}`}
                touchIndex={idx}
                subject={f.subject}
                body={f.body}
                sent={sentMessages[idx]}
                sending={sending}
                onCopy={(t) => copy(`fu${i}`, t)}
                copied={copied === `fu${i}`}
                onSend={doSend}
                disabled={!sentMessages[0]}
                disabledReason={!sentMessages[0] ? 'Send the initial email first' : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
