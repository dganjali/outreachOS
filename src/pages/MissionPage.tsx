import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { agents, gmail } from '../lib/api';
import { asScore } from '../lib/score';
import { CsvImport } from '../components/CsvImport';
import { AutopilotPanel } from '../components/AutopilotPanel';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '../components/ui/accordion';
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
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [mission, setMission] = useState<Mission | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [contactsByTarget, setContactsByTarget] = useState<Record<string, Contact[]>>({});
  const [packsByTarget, setPacksByTarget] = useState<Record<string, EvidencePack | undefined>>({});
  // null = loaded, no sequence; undefined = not loaded yet. The distinction
  // matters: storing undefined for "none" made the loader effect refire
  // endlessly (its guard never tripped), flooding the API with requests.
  const [sequencesByContact, setSequencesByContact] = useState<Record<string, EmailSequence | null | undefined>>({});
  // Sequence ids whose initial email (touch 0) has already been sent. Tracked at
  // page level - separate from each card's local state - so "Send all" can skip
  // already-sent contacts and never double-send.
  const [initialSentSeqIds, setInitialSentSeqIds] = useState<Set<string>>(new Set());
  // Bumped after a bulk send so SequenceCards remount and re-read their sent state.
  const [refreshKey, setRefreshKey] = useState(0);
  const [sendingAll, setSendingAll] = useState(false);
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
  // and - because "no sequence" was stored as undefined - the old per-contact
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

      // Which of these sequences have already had their initial email sent.
      const seqIds = Object.values(map).filter(Boolean).map((s) => (s as EmailSequence).id);
      if (seqIds.length === 0) {
        setInitialSentSeqIds(new Set());
        return;
      }
      const { data: sent } = await supabase
        .from('sent_messages')
        .select('sequence_id, touch_index, status')
        .in('sequence_id', seqIds)
        .eq('touch_index', 0)
        .eq('status', 'sent');
      if (cancelled) return;
      setInitialSentSeqIds(new Set((sent ?? []).map((m) => (m as { sequence_id: string }).sequence_id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [contactIdsKey, refreshKey]);

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

  // Contacts whose initial email is drafted, has a recipient address, hasn't been
  // sent yet, and isn't a known reply - i.e. the ones "Send all" would send to.
  const sendableInitials = useMemo(() => {
    const out: { sequenceId: string; email: string; name: string }[] = [];
    for (const c of allContacts) {
      if (c.status === 'replied') continue;
      const seq = sequencesByContact[c.id];
      if (!seq) continue;
      if (initialSentSeqIds.has(seq.id)) continue;
      const email = c.email || suggestEmail(c);
      if (!email) continue;
      out.push({ sequenceId: seq.id, email, name: c.name });
    }
    return out;
  }, [allContacts, sequencesByContact, initialSentSeqIds]);

  async function sendAllInitial() {
    const jobs = sendableInitials;
    if (jobs.length === 0) return;
    const ok = await confirm({
      title: `Send ${jobs.length} initial email${jobs.length > 1 ? 's' : ''} now?`,
      description: 'Sends the first email to every contact that has a draft and a recipient address. Already-sent contacts are skipped.',
      confirmText: `Send ${jobs.length}`,
    });
    if (!ok) return;
    setSendingAll(true);
    let sent = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await gmail.send(job.sequenceId, 0, 'send', job.email);
        sent++;
      } catch {
        failed++;
      }
    }
    setSendingAll(false);
    setRefreshKey((k) => k + 1); // remount cards so they reflect the new sent state
    if (failed === 0) toast.success(`Sent ${sent} email${sent > 1 ? 's' : ''}.`);
    else if (sent === 0) toast.error(`Could not send. ${failed} failed - check your Gmail connection in Settings.`);
    else toast.warning(`Sent ${sent}, but ${failed} failed.`);
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
    if (!(await confirm({ title: `Remove ${target.company_name}?`, confirmText: 'Remove', destructive: true }))) return;
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
  // Companies the pipeline dropped for having no reachable contact are marked
  // 'rejected' - keep them out of the output so the user only sees real targets.
  const visibleTargets = targets.filter((t) => t.status !== 'rejected');

  return (
    <div className="mission-detail">
      <Link to="/missions" className="mission-detail-back">
        ← Missions
      </Link>

      <header className="mission-detail-header">
        <div className="mission-detail-headline">
          <h1 style={{ margin: 0 }}>{mission.name}</h1>
          <div className="mission-detail-meta">
            <span className="mode-pill">{MODE_LABEL[mission.mode] ?? mission.mode}</span>
            <span className="mission-detail-stats">
              <span>{visibleTargets.length} targets</span>
              <span>{totalContacts} contacts</span>
              <span>{totalDrafts} drafts</span>
            </span>
          </div>
        </div>
        <div className="mission-detail-actions">
          <CsvImport missionId={mission.id} onImported={loadTargets} />
          {sendableInitials.length > 0 && (
            <button
              type="button"
              className="btn-send-all"
              disabled={sendingAll}
              onClick={sendAllInitial}
              title="Send the initial email to every contact that has a draft and a recipient address"
            >
              {sendingAll ? (
                `Sending ${sendableInitials.length}…`
              ) : (
                <>
                  <Send size={15} aria-hidden /> Send all ({sendableInitials.length})
                </>
              )}
            </button>
          )}
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

      <AutopilotPanel missionId={mission.id} />

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

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: '0.75rem' }}>Targets</h2>
        {visibleTargets.length === 0 ? (
          <div className="empty-illo">
            <h3>No targets yet</h3>
            <p>
              Run the full pipeline to find companies, build evidence, surface the right
              contacts, and draft initial emails — live, in one go. Or drive each step yourself.
            </p>
            <div className="empty-steps" aria-hidden>
              <span><b>1</b> Find targets</span>
              <span><b>2</b> Research &amp; contacts</span>
              <span><b>3</b> Drafts ready</span>
            </div>
            <div className="empty-illo-actions">
              <button
                type="button"
                className="btn-primary go"
                onClick={() => navigate(`/missions/${mission.id}/run`)}
              >
                Run pipeline
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy === 'targeting'}
                onClick={findTargets}
              >
                {busy === 'targeting' ? 'Researching…' : 'Find targets manually'}
              </button>
            </div>
          </div>
        ) : (
          <Accordion
            type="multiple"
            className="target-accordion"
            defaultValue={visibleTargets[0] ? [visibleTargets[0].id] : []}
          >
            {visibleTargets.map((t) => {
              const contacts = contactsByTarget[t.id] ?? [];
              const pack = packsByTarget[t.id];
              const score = asScore(t.score);
              const draftCount = contacts.filter((c) => sequencesByContact[c.id]).length;
              return (
                <AccordionItem
                  key={t.id}
                  value={t.id}
                  className={`target-item status-${t.status} ${activeTargetId === t.id ? 'active' : ''}`}
                >
                  <AccordionTrigger className="target-trigger">
                    <span className="target-summary">
                      <span className="target-summary-main">
                        <span className="target-summary-name">{t.company_name}</span>
                        <span className="target-summary-chips">
                          {score != null && (
                            <span className="target-score" title="Fit score">
                              {score}
                            </span>
                          )}
                          {t.signal_type && <span className="signal-pill subtle">{t.signal_type}</span>}
                        </span>
                      </span>
                      <span className="target-summary-meta">
                        <span>
                          {contacts.length > 0
                            ? `${contacts.length} contact${contacts.length === 1 ? '' : 's'}`
                            : 'No contacts'}
                        </span>
                        {draftCount > 0 && (
                          <span className="target-summary-drafts">
                            {draftCount} draft{draftCount === 1 ? '' : 's'}
                          </span>
                        )}
                      </span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="target-content">
                    <div className="target-content-head">
                      <div className="target-content-meta">
                        {t.domain && (
                          <a href={`https://${t.domain}`} target="_blank" rel="noreferrer" className="target-domain">
                            {t.domain} ↗
                          </a>
                        )}
                        {t.industry && <span className="signal-pill subtle">{t.industry}</span>}
                        {typeof t.employee_count === 'number' && (
                          <span className="signal-pill subtle">{t.employee_count.toLocaleString()} ppl</span>
                        )}
                      </div>
                      <div className="target-content-controls">
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
                          className="link-button target-delete"
                          onClick={() => deleteTarget(t)}
                          title="Remove target"
                        >
                          ×
                        </button>
                      </div>
                    </div>

                  {(t.why_now || t.fit_reason) && (
                    <div className="target-rationale">
                      {t.why_now && <p className="target-whynow"><strong>Why now</strong> {t.why_now}</p>}
                      {t.fit_reason && <p className="target-fit">{t.fit_reason}</p>}
                    </div>
                  )}

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
                              <div className="contact-identity">
                                <span className="contact-name-line">
                                  <strong>{c.name}</strong>
                                  <span className="contact-role">{c.role}</span>
                                </span>
                                {typeof c.confidence === 'number' && (
                                  <span className="confidence" title="Confidence">
                                    {Math.round(c.confidence * 100)}%
                                  </span>
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
                                      title="They wrote back in Gmail - stop their scheduled follow-ups"
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

                            {seq && <SequenceCard key={`${seq.id}:${refreshKey}`} sequence={seq} contact={c} />}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {contacts.length === 0 && (
                    <div className="contact-empty">
                      <span>
                        {pack
                          ? 'No contacts yet. Hit “Find contacts” to surface the decision-makers, then draft an email to each.'
                          : 'No contacts yet. Build an evidence pack first, then find contacts to draft personalized emails to.'}
                      </span>
                    </div>
                  )}
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </section>
    </div>
  );
}

function SequenceCard({ sequence, contact }: { sequence: EmailSequence; contact: Contact }) {
  // Collapsed by default: inside an expanded company, auto-opening every draft is
  // exactly the wall-of-text the accordion hierarchy is meant to avoid.
  const [open, setOpen] = useState(false);
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
      if (mode === 'send' && r.warnings && r.warnings.length > 0) {
        toast.warning(`Sent, with deliverability notes: ${r.warnings.join(' · ')}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      setSendErr(msg);
      if (msg.includes('no_recipient_email') || msg.includes('Provide to_override')) setNeedsEmail(true);
    } finally {
      setSending(null);
    }
  }

  async function doSchedule(touchIndex: number, whenISO: string) {
    setSendErr(null);
    setSending(`schedule:${touchIndex}`);
    try {
      const r = await gmail.send(sequence.id, touchIndex, 'send', overrideEmail || undefined, whenISO);
      setSentMessages((s) => ({
        ...s,
        [touchIndex]: {
          ...(s[touchIndex] as SentMessage | undefined),
          id: r.sent_message_id,
          touch_index: touchIndex,
          status: 'queued',
          scheduled_send_at: r.scheduled_send_at ?? whenISO,
          sent_at: null,
        } as SentMessage,
      }));
      setNeedsEmail(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not schedule';
      setSendErr(msg);
      if (msg.includes('no_recipient_email') || msg.includes('Provide to_override')) setNeedsEmail(true);
    } finally {
      setSending(null);
    }
  }

  async function cancelSchedule(touchIndex: number) {
    const row = sentMessages[touchIndex];
    if (!row) return;
    setSending(`cancel:${touchIndex}`);
    try {
      // Revert the queued row back to a plain draft so the cron skips it and the
      // Send/Schedule controls reappear.
      const { error } = await supabase
        .from('sent_messages')
        .update({ status: 'draft', scheduled_send_at: null })
        .eq('id', row.id);
      if (error) throw new Error(error.message);
      setSentMessages((s) => ({
        ...s,
        [touchIndex]: { ...(s[touchIndex] as SentMessage), status: 'draft', scheduled_send_at: null },
      }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not cancel');
    } finally {
      setSending(null);
    }
  }

  return (
    <div className={`sequence-card${open ? ' open' : ''}`}>
      <button type="button" className="sequence-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="sequence-toggle-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="sequence-toggle-label">Draft email{draft.followups.length > 0 ? ' sequence' : ''}</span>
        {sequence.primary_angle && <span className="angle-pill">{sequence.primary_angle}</span>}
        {sequence.autopilot_state && (
          <span className={`badge ${autopilotBadgeTone(sequence.autopilot_state)}`}>
            {autopilotLabel(sequence.autopilot_state)}
          </span>
        )}
        {!open && draft.followups.length > 0 && (
          <span className="sequence-toggle-count">{draft.followups.length + 1} emails</span>
        )}
      </button>
      {open && (
        <div className="sequence-body">
          {sequence.autopilot_state === 'ready' && (
            <div className="autopilot-banner ok">
              <span>Passed the Autopilot gate: verified address, high confidence.</span>
              <button
                type="button"
                className="btn-send"
                disabled={!!sending}
                onClick={() => doSend(0, 'send')}
              >
                {sending === 'send:0' ? 'Sending…' : 'Approve & send'}
              </button>
            </div>
          )}
          {sequence.autopilot_state === 'review' && (
            <div className="autopilot-banner warn">
              Held by Autopilot for review: the address is not verified, or confidence is below your threshold.
            </div>
          )}
          {(needsEmail || !contact.email) && (
            <div className="email-override">
              <label>
                {contact.likely_email_pattern
                  ? `Recipient email (no verified address - pattern suggests ${contact.likely_email_pattern})`
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
            label="Initial email"
            touchIndex={0}
            recipientName={contact.name}
            recipientEmail={overrideEmail || contact.email || ''}
            subject={draft.subject}
            body={draft.body}
            sent={sentMessages[0]}
            sending={sending}
            onCopy={(t) => copy('initial', t)}
            copied={copied === 'initial'}
            onSend={doSend}
            onSchedule={doSchedule}
            onCancelSchedule={cancelSchedule}
            onSave={saveTouch}
            disabled={!contact.email && !overrideEmail}
            disabledReason={
              !contact.email && !overrideEmail
                ? 'No email for this contact - enter a recipient address above'
                : undefined
            }
          />
          {draft.followups.map((f, i) => {
            const idx = i + 1;
            return (
              <Touch
                key={i}
                label={`Follow-up ${i + 1}`}
                sublabel={`sends ${f.wait_days} day${f.wait_days === 1 ? '' : 's'} after the previous email`}
                touchIndex={idx}
                recipientName={contact.name}
                recipientEmail={overrideEmail || contact.email || ''}
                subject={f.subject}
                body={f.body}
                sent={sentMessages[idx]}
                sending={sending}
                onCopy={(t) => copy(`fu${i}`, t)}
                copied={copied === `fu${i}`}
                onSend={doSend}
                onSchedule={doSchedule}
                onCancelSchedule={cancelSchedule}
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

function autopilotLabel(state: NonNullable<EmailSequence['autopilot_state']>): string {
  if (state === 'ready') return 'Autopilot · ready';
  if (state === 'review') return 'Autopilot · review';
  return 'Autopilot · queued';
}

function autopilotBadgeTone(state: NonNullable<EmailSequence['autopilot_state']>): string {
  if (state === 'ready') return 'is-success';
  if (state === 'review') return 'is-warn';
  return 'is-info';
}

// datetime-local value (YYYY-MM-DDTHH:mm) for "an hour from now", in local time.
function defaultScheduleLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatScheduleStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
  sublabel,
  touchIndex,
  recipientName,
  recipientEmail,
  subject,
  body,
  sent,
  sending,
  onCopy,
  copied,
  onSend,
  onSchedule,
  onCancelSchedule,
  onSave,
  disabled,
  disabledReason,
}: {
  label: string;
  sublabel?: string;
  touchIndex: number;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
  sent: SentMessage | undefined;
  sending: string | null;
  onCopy: (text: string) => void;
  copied: boolean;
  onSend: (touchIndex: number, mode: 'draft' | 'send') => Promise<void>;
  onSchedule: (touchIndex: number, whenISO: string) => Promise<void>;
  onCancelSchedule: (touchIndex: number) => Promise<void>;
  onSave: (touchIndex: number, subject: string, body: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const confirm = useConfirm();
  const isSent = sent?.status === 'sent';
  const isScheduled = sent?.status === 'queued' && !!sent?.scheduled_send_at;
  const isDraft = sent?.status === 'draft';
  const busy = !!sending;
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(() => defaultScheduleLocal());
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
    <div className={`email-card${isSent ? ' is-sent' : ''}`}>
      <div className="email-card-head">
        <span className="email-card-step">
          {label}
          {sublabel && <span className="email-card-sublabel">{sublabel}</span>}
        </span>
        {isSent && <span className="sent-badge">✓ sent</span>}
        {isScheduled && <span className="sent-badge scheduled">scheduled · {formatScheduleStamp(sent!.scheduled_send_at!)}</span>}
        {isDraft && !isSent && !isScheduled && <span className="sent-badge draft">draft saved</span>}
      </div>

      {editing ? (
        <div className="email-card-edit">
          <label className="email-field-label">Subject</label>
          <input
            className="reply-subject-input"
            value={s}
            onChange={(e) => setS(e.target.value)}
            placeholder="Subject"
          />
          <label className="email-field-label">Message</label>
          <textarea
            className="reply-body-input"
            value={b}
            onChange={(e) => setB(e.target.value)}
            rows={9}
          />
          <div className="email-card-actions">
            <button type="button" className="btn-primary small" onClick={save} disabled={saving || !b.trim()}>
              {saving ? 'Saving…' : 'Save changes'}
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
          <div className="email-meta">
            {recipientEmail && (
              <div className="email-meta-row">
                <span className="email-meta-key">To</span>
                <span className="email-meta-val">
                  {recipientName} <span className="email-meta-addr">&lt;{recipientEmail}&gt;</span>
                </span>
              </div>
            )}
            <div className="email-meta-row">
              <span className="email-meta-key">Subject</span>
              <span className="email-meta-val email-meta-subject">{subject}</span>
            </div>
          </div>

          <div className="email-body">{body}</div>

          {isScheduled ? (
            <div className="email-card-actions">
              <span className="schedule-note">
                Sends automatically {formatScheduleStamp(sent!.scheduled_send_at!)}
              </span>
              <button
                type="button"
                className="btn-send"
                disabled={busy || disabled}
                title={disabledReason}
                onClick={async () => {
                  if (
                    await confirm({
                      title: 'Send this email now?',
                      description: `To ${recipientName}${recipientEmail ? ` <${recipientEmail}>` : ''}\nSubject: ${subject}`,
                      confirmText: 'Send now',
                    })
                  )
                    onSend(touchIndex, 'send');
                }}
              >
                {sending === `send:${touchIndex}` ? (
                  'Sending…'
                ) : (
                  <>
                    <Send size={14} aria-hidden /> Send now
                  </>
                )}
              </button>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => onCancelSchedule(touchIndex)}
              >
                {sending === `cancel:${touchIndex}` ? 'Canceling…' : 'Cancel schedule'}
              </button>
            </div>
          ) : (
            <>
              <div className="email-card-actions">
                {!isSent && (
                  <button
                    type="button"
                    className="btn-send"
                    disabled={busy || disabled}
                    title={disabledReason}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'Send this email now?',
                          description: `To ${recipientName}${recipientEmail ? ` <${recipientEmail}>` : ''}\nSubject: ${subject}`,
                          confirmText: 'Send now',
                        })
                      )
                        onSend(touchIndex, 'send');
                    }}
                  >
                    {sending === `send:${touchIndex}` ? (
                      'Sending…'
                    ) : (
                      <>
                        <Send size={14} aria-hidden /> Send email
                      </>
                    )}
                  </button>
                )}
                {!isSent && (
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || disabled}
                    title={disabledReason}
                    onClick={() => setPicking((p) => !p)}
                  >
                    Schedule
                  </button>
                )}
                {!isSent && (
                  <button type="button" className="link-button" onClick={() => setEditing(true)}>
                    Edit
                  </button>
                )}
                {!isSent && (
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy || disabled}
                    title={disabledReason}
                    onClick={() => onSend(touchIndex, 'draft')}
                  >
                    {sending === `draft:${touchIndex}` ? 'Saving…' : isDraft ? 'Update Gmail draft' : 'Save to Gmail drafts'}
                  </button>
                )}
                <button type="button" className="link-button" onClick={() => onCopy(`Subject: ${subject}\n\n${body}`)}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {picking && !isSent && (
                <div className="schedule-picker">
                  <label className="email-field-label">Send at</label>
                  <input
                    type="datetime-local"
                    className="reply-subject-input"
                    value={when}
                    min={defaultScheduleLocal()}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                  <div className="email-card-actions">
                    <button
                      type="button"
                      className="btn-primary small"
                      disabled={busy || disabled || !when}
                      onClick={async () => {
                        const iso = new Date(when).toISOString();
                        if (new Date(iso).getTime() <= Date.now()) {
                          toast.error('Pick a time in the future.');
                          return;
                        }
                        await onSchedule(touchIndex, iso);
                        setPicking(false);
                      }}
                    >
                      {sending === `schedule:${touchIndex}` ? 'Scheduling…' : 'Schedule send'}
                    </button>
                    <button type="button" className="link-button" onClick={() => setPicking(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
