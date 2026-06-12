import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { agents, gmail } from '../lib/api';
import { asScore } from '../lib/score';
import { CsvImport } from '../components/CsvImport';
import { AutopilotPanel } from '../components/AutopilotPanel';
import type {
  Mission,
  Target,
  Contact,
  EvidencePack,
  EmailSequence,
  SentMessage,
} from '../types';

const MODE_LABEL: Record<string, string> = {
  sponsorship: 'Sponsorship',
  bd: 'BD / Partnerships',
  internship: 'Internship / Job',
  recruiting: 'Recruiting',
  sales: 'Cold Sales',
};

export function MissionPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mission, setMission] = useState<Mission | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [contactsByTarget, setContactsByTarget] = useState<Record<string, Contact[]>>({});
  const [packsByTarget, setPacksByTarget] = useState<Record<string, EvidencePack | undefined>>({});
  // null = loaded, no sequence; undefined = not loaded yet. The distinction
  // matters: storing undefined for "none" made the loader effect refire
  // endlessly (its guard never tripped), flooding the API with requests.
  const [sequencesByContact, setSequencesByContact] = useState<Record<string, EmailSequence | null | undefined>>({});
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadMission = useCallback(async () => {
    if (!id || !user?.id) return;
    const { data } = await supabase
      .from('missions')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single();
    setMission(data as Mission | null);
  }, [id, user?.id]);

  const loadTargets = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase
      .from('targets')
      .select('*')
      .eq('mission_id', id)
      .order('score', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
    setTargets((data ?? []) as Target[]);
  }, [id]);

  const loadContactsForTarget = useCallback(async (targetId: string) => {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('target_id', targetId)
      .order('confidence', { ascending: false, nullsFirst: false });
    setContactsByTarget((s) => ({ ...s, [targetId]: (data ?? []) as Contact[] }));
  }, []);

  const loadEvidenceForTarget = useCallback(async (targetId: string) => {
    const { data } = await supabase
      .from('evidence_packs')
      .select('*')
      .eq('target_id', targetId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setPacksByTarget((s) => ({ ...s, [targetId]: (data as EvidencePack | null) ?? undefined }));
  }, []);

  const loadSequencesForContact = useCallback(async (contactId: string) => {
    const { data } = await supabase
      .from('email_sequences')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setSequencesForContactDone(contactId, (data as EmailSequence | null) ?? null);
  }, []);

  function setSequencesForContactDone(contactId: string, seq: EmailSequence | null) {
    setSequencesByContact((s) => ({ ...s, [contactId]: seq }));
  }

  useEffect(() => {
    loadMission();
    loadTargets();
  }, [loadMission, loadTargets]);

  // Batched: contacts + evidence for ALL targets in two requests (was 2 per
  // target). Keyed on the id list so it only refires when the set changes.
  const targetIdsKey = useMemo(() => targets.map((t) => t.id).join(','), [targets]);
  useEffect(() => {
    const ids = targetIdsKey ? targetIdsKey.split(',') : [];
    if (ids.length === 0) {
      setContactsByTarget({});
      setPacksByTarget({});
      return;
    }
    let cancelled = false;
    (async () => {
      const [cRes, eRes] = await Promise.all([
        supabase.from('contacts').select('*').in('target_id', ids).order('confidence', { ascending: false, nullsFirst: false }),
        supabase.from('evidence_packs').select('*').in('target_id', ids).order('created_at', { ascending: false }),
      ]);
      if (cancelled) return;
      const byTarget: Record<string, Contact[]> = {};
      for (const tid of ids) byTarget[tid] = [];
      for (const c of (cRes.data ?? []) as Contact[]) (byTarget[c.target_id] ??= []).push(c);
      setContactsByTarget(byTarget);
      const packs: Record<string, EvidencePack | undefined> = {};
      for (const p of (eRes.data ?? []) as EvidencePack[]) {
        if (!packs[p.target_id]) packs[p.target_id] = p; // ordered desc → first is newest
      }
      setPacksByTarget(packs);
    })();
    return () => {
      cancelled = true;
    };
  }, [targetIdsKey]);

  const allContacts = useMemo(
    () => Object.values(contactsByTarget).flat(),
    [contactsByTarget]
  );

  // Batched: one email_sequences request for ALL contacts (was 1 per contact,
  // and — because "no sequence" was stored as undefined — the old per-contact
  // effect refired endlessly for any contact without a draft, flooding the API.
  const contactIdsKey = useMemo(() => allContacts.map((c) => c.id).sort().join(','), [allContacts]);
  useEffect(() => {
    const ids = contactIdsKey ? contactIdsKey.split(',') : [];
    if (ids.length === 0) {
      setSequencesByContact({});
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('email_sequences')
        .select('*')
        .in('contact_id', ids)
        .order('created_at', { ascending: false });
      if (cancelled) return;
      const map: Record<string, EmailSequence | null> = {};
      for (const cid of ids) map[cid] = null;
      for (const s of (data ?? []) as EmailSequence[]) {
        if (!map[s.contact_id]) map[s.contact_id] = s; // ordered desc → first is newest
      }
      setSequencesByContact(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [contactIdsKey]);

  async function runWith<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function findTargets() {
    if (!mission) return;
    const r = await runWith('targeting', () => agents.target(mission.id, 10));
    if (r) await loadTargets();
  }

  async function findContacts(target: Target) {
    setActiveTargetId(target.id);
    const r = await runWith(`contacts:${target.id}`, () => agents.contacts(target.id));
    if (r) await loadContactsForTarget(target.id);
  }

  async function buildEvidence(target: Target) {
    setActiveTargetId(target.id);
    const r = await runWith(`evidence:${target.id}`, () => agents.evidence(target.id));
    if (r) await loadEvidenceForTarget(target.id);
  }

  async function generateSequence(contact: Contact) {
    const r = await runWith(`sequence:${contact.id}`, () => agents.sequence(contact.id));
    if (r) await loadSequencesForContact(contact.id);
  }

  async function setTargetStatus(target: Target, status: Target['status']) {
    const { error } = await supabase.from('targets').update({ status }).eq('id', target.id);
    if (error) {
      toast.error(`Could not update ${target.company_name}: ${error.message}`);
      return;
    }
    setTargets((ts) => ts.map((t) => (t.id === target.id ? { ...t, status } : t)));
  }

  async function deleteTarget(target: Target) {
    if (!confirm(`Remove ${target.company_name}?`)) return;
    const { error } = await supabase.from('targets').delete().eq('id', target.id);
    if (error) {
      toast.error(`Could not remove ${target.company_name}: ${error.message}`);
      return;
    }
    setTargets((ts) => ts.filter((t) => t.id !== target.id));
  }

  // With send-only Gmail scope the app can't see replies, so this is the
  // reply-stop: the user marks the contact replied and the follow-up cron
  // skips them at send time (it checks contact.status === 'replied').
  async function markContactReplied(c: Contact) {
    const { error } = await supabase.from('contacts').update({ status: 'replied' }).eq('id', c.id);
    if (error) {
      toast.error(`Could not mark ${c.name} as replied: ${error.message}`);
      return;
    }
    setContactsByTarget((s) => {
      const next: typeof s = {};
      for (const [tid, list] of Object.entries(s)) {
        next[tid] = list.map((x) => (x.id === c.id ? { ...x, status: 'replied' as Contact['status'] } : x));
      }
      return next;
    });
    toast.success(`Marked ${c.name} as replied. Their scheduled follow-ups will not send.`);
  }

  if (!mission) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;
  }

  const totalContacts = allContacts.length;
  const totalDrafts = Object.values(sequencesByContact).filter(Boolean).length;

  return (
    <div className="mission-detail">
      <Link to="/missions" className="mission-detail-back">
        ← Missions
      </Link>

      <header className="mission-detail-header">
        <div>
          <h1 style={{ margin: 0 }}>{mission.name}</h1>
          <p className="mission-detail-meta">
            <span className="mode-pill">{MODE_LABEL[mission.mode] ?? mission.mode}</span>
            <span>· {targets.length} targets · {totalContacts} contacts · {totalDrafts} drafts</span>
          </p>
        </div>
        <div className="mission-detail-actions">
          <CsvImport missionId={mission.id} onImported={loadTargets} />
          <button
            type="button"
            className="btn-secondary"
            disabled={busy === 'targeting'}
            onClick={findTargets}
          >
            {busy === 'targeting' ? 'Researching…' : targets.length === 0 ? 'Find targets' : 'Find more targets'}
          </button>
          <button
            type="button"
            className="btn-primary go"
            onClick={() => navigate(`/missions/${mission.id}/run`)}
            title="Find targets, build evidence packs, find contacts, and draft initial emails, live."
          >
            Run pipeline
          </button>
        </div>
      </header>

      <section className="mission-overview-card">
        <div className="mission-overview-row">
          <strong>Offer</strong>
          <span>{mission.goal}</span>
        </div>
        <div className="mission-overview-row">
          <strong>Audience</strong>
          <span>{mission.target_description}</span>
        </div>
      </section>

      <AutopilotPanel missionId={mission.id} />

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: '0.75rem' }}>Targets</h2>
        {targets.length === 0 ? (
          <div className="empty-illo">
            <div className="empty-illo-graphic" aria-hidden>🎯</div>
            <h3>No targets yet</h3>
            <p>
              Click <strong>Run pipeline</strong> to find targets, build evidence packs, find contacts, and draft initial emails, live, in one go. Or use <strong>Find targets</strong> if you want to drive each step manually.
            </p>
          </div>
        ) : (
          <div className="target-list">
            {targets.map((t) => {
              const contacts = contactsByTarget[t.id] ?? [];
              const pack = packsByTarget[t.id];
              const isActive = activeTargetId === t.id;
              const score = asScore(t.score);
              return (
                <article
                  key={t.id}
                  className={`target-card ${isActive ? 'active' : ''} status-${t.status}`}
                >
                  <header className="target-card-header">
                    <div className="target-card-title">
                      <h3>{t.company_name}</h3>
                      {t.domain && (
                        <a href={`https://${t.domain}`} target="_blank" rel="noreferrer" className="target-domain">
                          {t.domain} ↗
                        </a>
                      )}
                      {score != null && (
                        <span className="target-score" title="Fit score">
                          {score}
                        </span>
                      )}
                      {t.signal_type && <span className="signal-pill">{t.signal_type}</span>}
                      {t.source === 'apollo' && (
                        <span className="signal-pill subtle" title="Sourced from a verified directory">verified</span>
                      )}
                      {t.industry && <span className="signal-pill subtle">{t.industry}</span>}
                      {typeof t.employee_count === 'number' && (
                        <span className="signal-pill subtle">{t.employee_count.toLocaleString()} ppl</span>
                      )}
                    </div>
                    <div className="target-card-actions">
                      <select
                        value={t.status}
                        onChange={(e) => setTargetStatus(t, e.target.value as Target['status'])}
                      >
                        <option value="suggested">Suggested</option>
                        <option value="approved">Approved</option>
                        <option value="rejected">Rejected</option>
                        <option value="contacted">Contacted</option>
                      </select>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => deleteTarget(t)}
                        title="Remove target"
                      >
                        ×
                      </button>
                    </div>
                  </header>
                  {t.why_now && <p className="target-whynow"><strong>Why now:</strong> {t.why_now}</p>}
                  {t.fit_reason && <p className="target-fit">{t.fit_reason}</p>}

                  <div className="target-actions target-actions-grouped">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy === `evidence:${t.id}`}
                      onClick={() => buildEvidence(t)}
                    >
                      {busy === `evidence:${t.id}` ? 'Researching…' : pack ? '↻ Refresh evidence' : '+ Evidence pack'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy === `contacts:${t.id}`}
                      onClick={() => findContacts(t)}
                    >
                      {busy === `contacts:${t.id}`
                        ? 'Searching…'
                        : contacts.length > 0
                          ? `↻ Find more contacts (${contacts.length})`
                          : '+ Find contacts'}
                    </button>
                  </div>

                  {pack && pack.bullets.length > 0 && (
                    <details className="evidence-pack-collapsible" open={contacts.length === 0}>
                      <summary>Evidence pack ({pack.bullets.length} bullets)</summary>
                      <ol>
                        {pack.bullets.map((b, i) => (
                          <li key={i}>
                            <span className="evidence-fact">{b.fact}</span>
                            <span className="evidence-meta">
                              {b.signal_type && <span className="signal-pill subtle">{b.signal_type}</span>}
                              {b.recency && <span> · {b.recency}</span>}
                              {b.source_url && (
                                <>
                                  {' '}
                                  ·{' '}
                                  <a href={b.source_url} target="_blank" rel="noreferrer">
                                    {b.source_title || 'source'} ↗
                                  </a>
                                </>
                              )}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}

                  {contacts.length > 0 && (
                    <div className="contact-list">
                      <div className="contact-list-title">Contacts ({contacts.length})</div>
                      {contacts.map((c) => {
                        const seq = sequencesByContact[c.id];
                        return (
                          <div key={c.id} className="contact-row">
                            <div className="contact-row-head">
                              <div>
                                <strong>{c.name}</strong>
                                <span className="contact-role"> · {c.role}</span>
                                {typeof c.confidence === 'number' && (
                                  <span className="confidence" title="Confidence">
                                    {Math.round(c.confidence * 100)}%
                                  </span>
                                )}
                                {c.source === 'apollo' && (
                                  <span className="signal-pill subtle" title="Sourced from a verified directory">verified</span>
                                )}
                              </div>
                              <div className="contact-row-actions">
                                {c.linkedin_url && (
                                  <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="link-pill">
                                    LinkedIn ↗
                                  </a>
                                )}
                                {c.status === 'replied' ? (
                                  <span className="signal-pill subtle" title="Follow-ups stopped">replied</span>
                                ) : (
                                  c.status === 'contacted' && (
                                    <button
                                      type="button"
                                      className="btn-secondary small"
                                      title="They wrote back in Gmail — stop their scheduled follow-ups"
                                      onClick={() => markContactReplied(c)}
                                    >
                                      Mark replied
                                    </button>
                                  )
                                )}
                                <button
                                  type="button"
                                  className="btn-primary small"
                                  disabled={busy === `sequence:${c.id}` || !pack}
                                  title={!pack ? 'Build an evidence pack first' : ''}
                                  onClick={() => generateSequence(c)}
                                >
                                  {busy === `sequence:${c.id}` ? 'Drafting…' : seq ? 'Regenerate' : 'Draft email'}
                                </button>
                              </div>
                            </div>
                            {c.email && (
                              <div className="contact-email">
                                {c.email}{' '}
                                <EmailStatusPill status={c.email_status} />
                              </div>
                            )}
                            {!c.email && c.likely_email_pattern && (
                              <div className="contact-email muted">Pattern: {c.likely_email_pattern}</div>
                            )}
                            {c.headline && <div className="contact-reason muted">{c.headline}</div>}
                            {c.reasoning && <div className="contact-reason">{c.reasoning}</div>}

                            {seq && <SequenceCard sequence={seq} contact={c} />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function SequenceCard({ sequence, contact }: { sequence: EmailSequence; contact: Contact }) {
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<Record<number, SentMessage | undefined>>({});
  const [overrideEmail, setOverrideEmail] = useState(() => suggestEmail(contact));
  const [needsEmail, setNeedsEmail] = useState(false);
  const [draft, setDraft] = useState({
    subject: sequence.subject,
    body: sequence.body,
    followups: sequence.followups,
  });

  async function saveTouch(touchIndex: number, subject: string, body: string) {
    // Send reads subject/body from the server, so a silently failed save here
    // means the OLD text gets sent while the UI shows the edit. Must surface.
    if (touchIndex === 0) {
      const { error } = await supabase.from('email_sequences').update({ subject, body }).eq('id', sequence.id);
      if (error) {
        toast.error(`Draft not saved: ${error.message}`);
        throw new Error(error.message);
      }
      setDraft((d) => ({ ...d, subject, body }));
    } else {
      const followups = draft.followups.map((f, i) =>
        i === touchIndex - 1 ? { ...f, subject, body } : f
      );
      const { error } = await supabase.from('email_sequences').update({ followups }).eq('id', sequence.id);
      if (error) {
        toast.error(`Draft not saved: ${error.message}`);
        throw new Error(error.message);
      }
      setDraft((d) => ({ ...d, followups }));
    }
  }

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
          {(needsEmail || !contact.email) && (
            <div className="email-override">
              <label>
                {contact.likely_email_pattern
                  ? `Recipient email (no verified address — pattern suggests ${contact.likely_email_pattern})`
                  : 'Recipient email (no verified address on file)'}
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

          <Touch
            label="Initial"
            touchIndex={0}
            subject={draft.subject}
            body={draft.body}
            sent={sentMessages[0]}
            sending={sending}
            onCopy={(t) => copy('initial', t)}
            copied={copied === 'initial'}
            onSend={doSend}
            onSave={saveTouch}
            disabled={!contact.email && !overrideEmail}
            disabledReason={
              !contact.email && !overrideEmail
                ? 'No email for this contact — enter a recipient address above'
                : undefined
            }
          />
          {draft.followups.map((f, i) => {
            const idx = i + 1;
            return (
              <Touch
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
                onSave={saveTouch}
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

function suggestEmail(contact: Contact): string {
  if (contact.email) return contact.email;
  const pattern = contact.likely_email_pattern?.trim();
  if (!pattern || pattern.includes('@')) return pattern ?? '';
  const parts = contact.name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return '';
  const [first, last] = parts;
  if (pattern.includes('first') && pattern.includes('last')) {
    return pattern.replace(/first/gi, first).replace(/last/gi, last);
  }
  return '';
}

function EmailStatusPill({ status }: { status: Contact['email_status'] }) {
  if (!status || status === 'none') return null;
  const label = status === 'verified' ? 'verified' : status === 'likely' ? 'likely' : 'guessed';
  const tone = status === 'verified' ? 'verified' : status === 'likely' ? 'likely' : 'guessed';
  return (
    <span className={`email-status email-status-${tone}`} title={`Email status: ${label}`}>
      {label}
    </span>
  );
}

function Touch({
  label,
  touchIndex,
  subject,
  body,
  sent,
  sending,
  onCopy,
  copied,
  onSend,
  onSave,
  disabled,
  disabledReason,
}: {
  label: string;
  touchIndex: number;
  subject: string;
  body: string;
  sent: SentMessage | undefined;
  sending: string | null;
  onCopy: (text: string) => void;
  copied: boolean;
  onSend: (touchIndex: number, mode: 'draft' | 'send') => Promise<void>;
  onSave: (touchIndex: number, subject: string, body: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const isSent = sent?.status === 'sent';
  const isDraft = sent?.status === 'draft';
  const [editing, setEditing] = useState(false);
  const [s, setS] = useState(subject);
  const [b, setB] = useState(body);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) {
      setS(subject);
      setB(body);
    }
  }, [subject, body, editing]);

  async function save() {
    setSaving(true);
    try {
      await onSave(touchIndex, s, b);
      setEditing(false);
    } catch {
      // onSave already toasted; stay in edit mode so the user can retry.
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sequence-touch">
      <div className="sequence-touch-head">
        <span className="touch-label">
          {label}
          {isSent && <span className="sent-badge">sent</span>}
          {isDraft && <span className="sent-badge draft">draft saved</span>}
        </span>
        <div className="touch-actions">
          {!isSent && !editing && (
            <button type="button" className="link-button" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button type="button" className="link-button" onClick={() => onCopy(`Subject: ${subject}\n\n${body}`)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {!isSent && !editing && (
            <>
              <button
                type="button"
                className="btn-secondary tiny"
                disabled={!!sending || disabled}
                title={disabledReason}
                onClick={() => onSend(touchIndex, 'draft')}
              >
                {sending === `draft:${touchIndex}` ? 'Saving…' : isDraft ? 'Update draft' : 'Save draft'}
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
      {editing ? (
        <div className="sequence-edit">
          <input
            className="reply-subject-input"
            value={s}
            onChange={(e) => setS(e.target.value)}
            placeholder="Subject"
          />
          <textarea
            className="reply-body-input"
            value={b}
            onChange={(e) => setB(e.target.value)}
            rows={7}
          />
          <div className="sequence-edit-actions">
            <button type="button" className="btn-primary tiny" onClick={save} disabled={saving || !b.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setEditing(false);
                setS(subject);
                setB(body);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="sequence-subject">{subject}</div>
          <pre className="sequence-text">{body}</pre>
        </>
      )}
    </div>
  );
}
