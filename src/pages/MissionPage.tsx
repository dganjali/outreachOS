import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Send, Sparkles, Lock, Undo2, Paperclip, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { agents, gmail } from '../lib/api';
import { isPaidPlan } from '../../shared/plans';
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

const TARGET_STATUS_LABEL: Record<string, string> = {
  suggested: 'Suggested',
  approved: 'Approved',
  rejected: 'Rejected',
  contacted: 'Contacted',
};

// Turn raw agent error codes into something a person can read. Falls through to
// the original message for anything we don't have a friendlier line for.
function humanizeAgentError(msg: string): string {
  if (msg.includes('no_contacts_found'))
    return 'No reachable contact found for this company yet. Try refreshing the evidence pack, or move on to another target.';
  if (msg === 'agent_failed') return 'That step hit an error. Please try again in a moment.';
  return msg;
}

export function MissionPage() {
  const { id } = useParams<{ id: string }>();
  const { user, profile } = useAuth();
  // AI rewrite + feedback in the email editor is a paid feature.
  const aiEnabled = isPaidPlan(profile?.plan, profile?.plan_status);
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
  // Bulk contact selection (checkboxes + floating action bar).
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the user has a résumé on file - gates the "Attach résumé" send option.
  const [hasResume, setHasResume] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    supabase
      .from('profile_assets')
      .select('id')
      .eq('kind', 'resume')
      .limit(1)
      .then(({ data }) => {
        if (!cancelled) setHasResume((data ?? []).length > 0);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

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
      setError(humanizeAgentError(err instanceof Error ? err.message : 'Failed'));
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
    const prev = target.status;
    if (status === prev) return;
    const { error } = await supabase.from('targets').update({ status }).eq('id', target.id);
    if (error) {
      toast.error(`Could not update ${target.company_name}: ${error.message}`);
      return;
    }
    setTargets((ts) => ts.map((t) => (t.id === target.id ? { ...t, status } : t)));
    // Status changes are one-click and 'rejected' hides the target outright, so
    // a misclick (the dropdown sits next to the remove button) is easy. Always
    // offer a one-click undo back to the prior status.
    toast.success(`Marked ${target.company_name} as ${TARGET_STATUS_LABEL[status] ?? status}`, {
      action: {
        label: 'Undo',
        onClick: async () => {
          const { error: undoErr } = await supabase.from('targets').update({ status: prev }).eq('id', target.id);
          if (undoErr) {
            toast.error(`Could not undo: ${undoErr.message}`);
            return;
          }
          setTargets((ts) => ts.map((t) => (t.id === target.id ? { ...t, status: prev } : t)));
        },
      },
    });
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

  function toggleContactSelected(contactId: string) {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }

  function clearSelection() {
    setSelectedContactIds(new Set());
  }

  // Apply a status to every selected contact at once (bulk approve/reject), with
  // a single undo that restores each contact's prior status.
  async function bulkSetContactStatus(status: Contact['status']) {
    const ids = Array.from(selectedContactIds);
    if (ids.length === 0) return;
    const prior = new Map<string, Contact['status']>();
    for (const list of Object.values(contactsByTarget)) {
      for (const c of list) if (selectedContactIds.has(c.id)) prior.set(c.id, c.status);
    }
    setBulkBusy(true);
    try {
      const results = await Promise.all(
        ids.map((cid) => supabase.from('contacts').update({ status }).eq('id', cid))
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw new Error(failed.error.message);
      setContactsByTarget((byT) => {
        const next: Record<string, Contact[]> = {};
        for (const [tid, list] of Object.entries(byT)) {
          next[tid] = list.map((c) => (selectedContactIds.has(c.id) ? { ...c, status } : c));
        }
        return next;
      });
      const n = ids.length;
      clearSelection();
      toast.success(`Marked ${n} contact${n === 1 ? '' : 's'} as ${status}`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            await Promise.all(
              Array.from(prior.entries()).map(([cid, st]) =>
                supabase.from('contacts').update({ status: st }).eq('id', cid)
              )
            );
            setContactsByTarget((byT) => {
              const next: Record<string, Contact[]> = {};
              for (const [tid, list] of Object.entries(byT)) {
                next[tid] = list.map((c) => (prior.has(c.id) ? { ...c, status: prior.get(c.id)! } : c));
              }
              return next;
            });
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update contacts');
    } finally {
      setBulkBusy(false);
    }
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

      <MissionBriefCard mission={mission} onSaved={loadMission} />

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <section>
        <h2 className="targets-heading">
          Targets
          {visibleTargets.length > 0 && <span className="targets-count">{visibleTargets.length}</span>}
        </h2>
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
                        <span className="target-summary-top">
                          {score != null && (
                            <span className="target-score" title="Fit score">
                              {score}
                            </span>
                          )}
                          <span className="target-summary-name">{t.company_name}</span>
                          {t.signal_type && <span className="signal-pill" data-signal={t.signal_type}>{t.signal_type}</span>}
                        </span>
                        <span className="target-summary-sub">
                          {t.domain && <span className="target-summary-domain">{t.domain}</span>}
                          {t.industry && <span>{t.industry}</span>}
                          {typeof t.employee_count === 'number' && (
                            <span>{t.employee_count.toLocaleString()} ppl</span>
                          )}
                        </span>
                      </span>
                      <span className="target-summary-meta">
                        <span className={contacts.length > 0 ? 'target-summary-contacts' : 'target-summary-none'}>
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
                            Visit {t.domain} ↗
                          </a>
                        )}
                      </div>
                      <div className="target-content-controls">
                        <label className="target-status-control">
                          <span className="target-status-label">Status</span>
                          <select
                            value={t.status}
                            onChange={(e) => setTargetStatus(t, e.target.value as Target['status'])}
                            aria-label={`Status for ${t.company_name}`}
                          >
                            <option value="suggested">Suggested</option>
                            <option value="approved">Approved</option>
                            <option value="rejected">Rejected</option>
                            <option value="contacted">Contacted</option>
                          </select>
                        </label>
                        <span className="target-controls-sep" aria-hidden />
                        <button
                          type="button"
                          className="link-button target-delete"
                          onClick={() => deleteTarget(t)}
                          title={`Remove ${t.company_name}`}
                          aria-label={`Remove ${t.company_name}`}
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
                    <details className="evidence-pack-collapsible">
                      <summary>Evidence pack ({pack.bullets.length} bullets)</summary>
                      <ol>
                        {pack.bullets.map((b, i) => (
                          <li key={i}>
                            <span className="evidence-fact">{b.fact}</span>
                            <span className="evidence-meta">
                              {b.signal_type && <span className="signal-pill" data-signal={b.signal_type}>{b.signal_type}</span>}
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
                                  <span
                                    className="confidence"
                                    title="Estimated reply-likelihood — how promising this contact is to reach for this mission (role & seniority fit plus signals). Higher is better."
                                  >
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

                            {seq && <SequenceCard key={`${seq.id}:${refreshKey}`} sequence={seq} contact={c} aiEnabled={aiEnabled} hasResume={hasResume} onContactUpdated={() => loadContactsForTarget(t.id)} onSequenceUpdated={() => loadSequencesForContact(c.id)} />}
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

function SequenceCard({ sequence, contact, aiEnabled, hasResume, onContactUpdated, onSequenceUpdated }: { sequence: EmailSequence; contact: Contact; aiEnabled: boolean; hasResume: boolean; onContactUpdated?: () => void | Promise<void>; onSequenceUpdated?: () => void | Promise<void> }) {
  // Collapsed by default: inside an expanded company, auto-opening every draft is
  // exactly the wall-of-text the accordion hierarchy is meant to avoid.
  const [open, setOpen] = useState(false);
  // Follow-ups stay folded until asked for. They largely restate the initial
  // email, so showing the first touch alone keeps the reviewer focused on the
  // one message that actually varies.
  const [showFollowups, setShowFollowups] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<Record<number, SentMessage | undefined>>({});
  // Follow-ups are written asynchronously after the draft returns (see
  // api/agents/sequence.ts), so a fresh draft shows none until they land. Poll
  // briefly and surface a "writing…" state instead of looking empty.
  const [generatingFollowups, setGeneratingFollowups] = useState(false);
  const [overrideEmail, setOverrideEmail] = useState(() => suggestEmail(contact));
  const [needsEmail, setNeedsEmail] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [draft, setDraft] = useState({
    subject: sequence.subject,
    body: sequence.body,
    followups: sequence.followups,
  });

  // Persist the entered recipient address onto the contact so it's reused for
  // every email to them (and the "no verified address" warning clears), rather
  // than only routing this one send. onContactUpdated refreshes the parent.
  async function saveEmailToContact() {
    const email = overrideEmail.trim();
    if (!email || email === contact.email) return;
    setSavingEmail(true);
    try {
      const { error } = await supabase.from('contacts').update({ email }).eq('id', contact.id);
      if (error) throw new Error(error.message);
      toast.success('Email saved to contact');
      await onContactUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save email');
    } finally {
      setSavingEmail(false);
    }
  }

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

  // Toggle a single follow-up's skip state. Skipped touches are neither shown as
  // sendable nor auto-queued by scheduleFollowups (api/_lib/sequencing.ts).
  async function toggleFollowupSkip(index: number) {
    const followups = draft.followups.map((f, i) =>
      i === index ? { ...f, disabled: !f.disabled } : f
    );
    const { error } = await supabase.from('email_sequences').update({ followups }).eq('id', sequence.id);
    if (error) {
      toast.error(`Couldn't update follow-up: ${error.message}`);
      return;
    }
    setDraft((d) => ({ ...d, followups }));
  }

  // Poll for asynchronously-generated follow-ups while the card is open and the
  // draft was created recently. The recency gate avoids polling (and a stuck
  // "writing…" state) on old drafts whose generation genuinely produced none.
  useEffect(() => {
    if (!open || draft.followups.length > 0) return;
    const ageMs = Date.now() - new Date(sequence.created_at).getTime();
    if (!(ageMs >= 0 && ageMs < 3 * 60_000)) return;

    let cancelled = false;
    let ticks = 0;
    setGeneratingFollowups(true);
    const id = window.setInterval(async () => {
      ticks++;
      const { data } = await supabase
        .from('email_sequences')
        .select('followups')
        .eq('id', sequence.id)
        .maybeSingle();
      if (cancelled) return;
      const followups = (data?.followups ?? []) as EmailSequence['followups'];
      if (followups.length > 0) {
        setDraft((d) => ({ ...d, followups }));
        setGeneratingFollowups(false);
        window.clearInterval(id);
        void onSequenceUpdated?.();
      } else if (ticks >= 12) {
        // ~48s with no follow-ups: generation likely yielded none. Give up.
        setGeneratingFollowups(false);
        window.clearInterval(id);
      }
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      setGeneratingFollowups(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sequence.id, draft.followups.length]);

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

  async function doSend(touchIndex: number, mode: 'draft' | 'send', attachResume = false) {
    setSendErr(null);
    setSending(`${mode}:${touchIndex}`);
    try {
      const r = await gmail.send(sequence.id, touchIndex, mode, overrideEmail || undefined, undefined, attachResume);
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

  async function doSchedule(touchIndex: number, whenISO: string, attachResume = false) {
    setSendErr(null);
    setSending(`schedule:${touchIndex}`);
    try {
      const r = await gmail.send(sequence.id, touchIndex, 'send', overrideEmail || undefined, whenISO, attachResume);
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
              <span className="email-override-label">
                {contact.likely_email_pattern
                  ? `Recipient email — no verified address (pattern suggests ${contact.likely_email_pattern})`
                  : 'Recipient email — no verified address on file'}
              </span>
              <div className="email-override-row">
                <input
                  type="email"
                  value={overrideEmail}
                  onChange={(e) => setOverrideEmail(e.target.value)}
                  placeholder="contact@company.com"
                  aria-label="Recipient email address"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={savingEmail || !overrideEmail.trim() || overrideEmail.trim() === contact.email}
                  onClick={saveEmailToContact}
                >
                  {savingEmail ? 'Saving…' : 'Save to contact'}
                </button>
              </div>
              <p className="email-override-hint">
                Add an email to enable sending. <strong>Save to contact</strong> reuses it for every email to this
                person; otherwise it applies to this send only.
              </p>
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
            aiEnabled={aiEnabled}
            hasResume={hasResume}
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
          {generatingFollowups && draft.followups.length === 0 && (
            <div className="followups-generating">
              <span className="parse-toast-spinner" aria-hidden />
              Writing follow-ups…
            </div>
          )}
          {draft.followups.length > 0 && (
            <button
              type="button"
              className="followups-toggle"
              aria-expanded={showFollowups}
              onClick={() => setShowFollowups((v) => !v)}
            >
              <span className="followups-toggle-caret" aria-hidden>{showFollowups ? '▾' : '▸'}</span>
              {showFollowups
                ? 'Hide follow-ups'
                : `Show ${draft.followups.length} follow-up${draft.followups.length === 1 ? '' : 's'}`}
            </button>
          )}
          {showFollowups &&
            draft.followups.map((f, i) => {
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
                  aiEnabled={aiEnabled}
                  hasResume={hasResume}
                  onCopy={(t) => copy(`fu${i}`, t)}
                  copied={copied === `fu${i}`}
                  onSend={doSend}
                  onSchedule={doSchedule}
                  onCancelSchedule={cancelSchedule}
                  onSave={saveTouch}
                  skipped={!!f.disabled}
                  onToggleSkip={() => toggleFollowupSkip(i)}
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

// Editable mission brief. Outreach evolves, so the core pitch (offer / audience /
// location) and a private notes field can be refined after creation - not just at
// the wizard. View mode shows the brief with an Edit affordance; edit mode is an
// inline form that writes back to the mission and reloads.
function MissionBriefCard({
  mission,
  onSaved,
}: {
  mission: Mission;
  onSaved: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState(mission.goal);
  const [audience, setAudience] = useState(mission.target_description);
  const [geo, setGeo] = useState(mission.geo ?? '');
  const [notes, setNotes] = useState(mission.notes ?? '');
  const [saving, setSaving] = useState(false);

  // Re-sync from the source when it changes and we're not mid-edit.
  useEffect(() => {
    if (!editing) {
      setGoal(mission.goal);
      setAudience(mission.target_description);
      setGeo(mission.geo ?? '');
      setNotes(mission.notes ?? '');
    }
  }, [mission, editing]);

  async function save() {
    if (!goal.trim() || !audience.trim()) {
      toast.error('Offer and audience can’t be empty.');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('missions')
        .update({
          goal: goal.trim(),
          target_description: audience.trim(),
          geo: geo.trim() || null,
          notes: notes.trim() || null,
        })
        .eq('id', mission.id);
      if (error) throw new Error(error.message);
      await onSaved();
      setEditing(false);
      toast.success('Mission brief updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save changes');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <section className="mission-overview-card is-editing">
        <div className="mission-overview-edit">
          <label className="email-field-label">Offer</label>
          <textarea className="reply-body-input" rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} />
          <label className="email-field-label">Audience</label>
          <textarea
            className="reply-body-input"
            rows={3}
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          />
          <label className="email-field-label">Location focus (optional)</label>
          <input
            className="reply-subject-input"
            value={geo}
            onChange={(e) => setGeo(e.target.value)}
            placeholder="e.g. Toronto, Canada — scopes contact discovery"
          />
          <label className="email-field-label">Notes (optional)</label>
          <textarea
            className="reply-body-input"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Private context — e.g. “paused until August”, “post-Series A only”."
          />
          <div className="email-card-actions">
            <button type="button" className="btn-send" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" className="link-button" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mission-overview-card">
      <button type="button" className="mission-overview-edit-btn" onClick={() => setEditing(true)}>
        <Pencil size={13} aria-hidden /> Edit
      </button>
      <div className="mission-overview-grid">
        <div className="mission-overview-row">
          <strong>Offer</strong>
          <span>{mission.goal}</span>
        </div>
        <div className="mission-overview-row">
          <strong>Audience</strong>
          <span>{mission.target_description}</span>
        </div>
        {mission.geo && (
          <div className="mission-overview-row">
            <strong>Location</strong>
            <span>{mission.geo}</span>
          </div>
        )}
        {mission.notes && (
          <div className="mission-overview-row">
            <strong>Notes</strong>
            <span className="mission-overview-notes">{mission.notes}</span>
          </div>
        )}
      </div>
    </section>
  );
}

// One-tap rewrites + custom instructions for the draft, powered by the refine
// agent. Paid feature: free users see a locked upsell instead. `onApply` writes
// the rewritten subject/body back into the editor's local state so the user can
// keep tweaking (and still has Save / Cancel to commit or discard).
const AI_QUICK_ACTIONS: Array<{ label: string; instruction: string }> = [
  { label: 'Shorter', instruction: 'Make it noticeably shorter and tighter without dropping the core ask.' },
  { label: 'Warmer', instruction: 'Make the tone warmer and more personable, still professional.' },
  { label: 'More direct', instruction: 'Make it more direct and confident; cut hedging and filler.' },
  { label: 'Stronger CTA', instruction: 'Sharpen the call to action so the ask is specific and easy to say yes to.' },
  { label: 'Fix grammar', instruction: 'Fix grammar, spelling, and awkward phrasing; keep the wording otherwise intact.' },
];

function AiAssist({
  enabled,
  subject,
  body,
  onApply,
}: {
  enabled: boolean;
  subject: string;
  body: string;
  onApply: (subject: string, body: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Snapshot of the text just before the last rewrite, so a bad suggestion is one
  // click to undo.
  const [undoSnap, setUndoSnap] = useState<{ subject: string; body: string } | null>(null);

  if (!enabled) {
    return (
      <div className="ai-assist ai-assist-locked">
        <div className="ai-assist-lockhead">
          <Sparkles size={15} aria-hidden />
          <span>AI rewrite &amp; feedback</span>
          <span className="ai-assist-badge">Pro</span>
        </div>
        <p className="ai-assist-lockcopy">
          Rewrite for tone, length, or a stronger ask in one click — with a note on what changed.
        </p>
        <Link to="/settings" className="ai-assist-upgrade">
          <Lock size={13} aria-hidden /> Upgrade to unlock
        </Link>
      </div>
    );
  }

  async function run(label: string, text: string) {
    if (!body.trim() || busy) return;
    setBusy(label);
    setNote(null);
    const snap = { subject, body };
    try {
      const r = await agents.refine({ subject, body, instruction: text });
      onApply(r.subject || subject, r.body);
      setUndoSnap(snap);
      setNote(r.note);
      if (label === 'custom') setInstruction('');
    } catch (err) {
      toast.error(err instanceof Error ? humanizeAgentError(err.message) : 'Could not rewrite');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ai-assist">
      <div className="ai-assist-head">
        <Sparkles size={14} aria-hidden />
        <span>AI assist</span>
      </div>
      <div className="ai-assist-chips">
        {AI_QUICK_ACTIONS.map((a) => (
          <button
            key={a.label}
            type="button"
            className="ai-chip"
            disabled={!!busy}
            onClick={() => run(a.label, a.instruction)}
          >
            {busy === a.label ? 'Working…' : a.label}
          </button>
        ))}
      </div>
      <div className="ai-assist-custom">
        <input
          className="reply-subject-input"
          value={instruction}
          placeholder="Or tell the AI what to change…"
          disabled={!!busy}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && instruction.trim()) {
              e.preventDefault();
              run('custom', instruction.trim());
            }
          }}
        />
        <button
          type="button"
          className="ai-assist-rewrite"
          disabled={!!busy || !instruction.trim()}
          onClick={() => run('custom', instruction.trim())}
        >
          {busy === 'custom' ? 'Working…' : 'Rewrite'}
        </button>
      </div>
      {note && (
        <div className="ai-assist-note">
          <Sparkles size={13} aria-hidden />
          <span>{note}</span>
          {undoSnap && (
            <button
              type="button"
              className="ai-assist-undo"
              onClick={() => {
                onApply(undoSnap.subject, undoSnap.body);
                setUndoSnap(null);
                setNote(null);
              }}
            >
              <Undo2 size={12} aria-hidden /> Undo
            </button>
          )}
        </div>
      )}
    </div>
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
  aiEnabled,
  hasResume,
  onCopy,
  copied,
  onSend,
  onSchedule,
  onCancelSchedule,
  onSave,
  disabled,
  disabledReason,
  skipped,
  onToggleSkip,
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
  aiEnabled: boolean;
  hasResume: boolean;
  onCopy: (text: string) => void;
  copied: boolean;
  onSend: (touchIndex: number, mode: 'draft' | 'send', attachResume?: boolean) => Promise<void>;
  onSchedule: (touchIndex: number, whenISO: string, attachResume?: boolean) => Promise<void>;
  onCancelSchedule: (touchIndex: number) => Promise<void>;
  onSave: (touchIndex: number, subject: string, body: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
  skipped?: boolean;
  onToggleSkip?: () => void | Promise<void>;
}) {
  const confirm = useConfirm();
  const isSent = sent?.status === 'sent';
  // A skipped follow-up is not sendable: fold it into the existing disabled gate
  // so Send / Schedule / Save-to-Gmail all block, while Edit and Copy stay live.
  const sendDisabled = disabled || skipped;
  const sendDisabledReason = skipped ? "Skipped — won't auto-send" : disabledReason;
  const isScheduled = sent?.status === 'queued' && !!sent?.scheduled_send_at;
  const isDraft = sent?.status === 'draft';
  const busy = !!sending;
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [when, setWhen] = useState(() => defaultScheduleLocal());
  const [s, setS] = useState(subject);
  const [b, setB] = useState(body);
  const [saving, setSaving] = useState(false);
  // Per-touch choice to attach the résumé. Only offered when one is on file.
  const [attachResume, setAttachResume] = useState(false);

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
    <div className={`email-card${isSent ? ' is-sent' : ''}${skipped ? ' is-skipped' : ''}`}>
      <div className="email-card-head">
        <span className="email-card-step">
          {label}
          {sublabel && <span className="email-card-sublabel">{sublabel}</span>}
        </span>
        {isSent && <span className="sent-badge">✓ sent</span>}
        {isScheduled && <span className="sent-badge scheduled">scheduled · {formatScheduleStamp(sent!.scheduled_send_at!)}</span>}
        {isDraft && !isSent && !isScheduled && <span className="sent-badge draft">draft saved</span>}
        {skipped && <span className="sent-badge skipped">skipped</span>}
        {onToggleSkip && !isSent && !isScheduled && (
          <button type="button" className="link-button followup-skip-toggle" onClick={onToggleSkip}>
            {skipped ? 'Include' : 'Skip'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="email-card-edit">
          {/* Pinned toolbar: Save / Cancel stay above the fold while the long
              edit form (subject + body + AI assist) scrolls beneath it (#7). */}
          <div className="email-edit-toolbar">
            <span className="email-edit-toolbar-title">Editing draft</span>
            <div className="email-edit-toolbar-actions">
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setEditing(false);
                  setS(subject);
                  setB(body);
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button type="button" className="btn-send" onClick={save} disabled={saving || !b.trim()}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
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
            rows={6}
          />
          <AiAssist
            enabled={aiEnabled}
            subject={s}
            body={b}
            onApply={(subj, bod) => {
              setS(subj);
              setB(bod);
            }}
          />
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
                disabled={busy || sendDisabled}
                title={sendDisabledReason}
                onClick={async () => {
                  if (
                    await confirm({
                      title: 'Send this email now?',
                      description: `To ${recipientName}${recipientEmail ? ` <${recipientEmail}>` : ''}\nSubject: ${subject}`,
                      confirmText: 'Send now',
                    })
                  )
                    onSend(touchIndex, 'send', sent?.attach_resume ?? false);
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
                    disabled={busy || sendDisabled}
                    title={sendDisabledReason}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: 'Send this email now?',
                          description: `To ${recipientName}${recipientEmail ? ` <${recipientEmail}>` : ''}\nSubject: ${subject}`,
                          confirmText: 'Send now',
                        })
                      )
                        onSend(touchIndex, 'send', attachResume);
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
                    disabled={busy || sendDisabled}
                    title={sendDisabledReason}
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
                    disabled={busy || sendDisabled}
                    title={sendDisabledReason}
                    onClick={() => onSend(touchIndex, 'draft', attachResume)}
                  >
                    {sending === `draft:${touchIndex}` ? 'Saving…' : isDraft ? 'Update Gmail draft' : 'Save to Gmail drafts'}
                  </button>
                )}
                <button type="button" className="link-button" onClick={() => onCopy(`Subject: ${subject}\n\n${body}`)}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {!isSent && hasResume && (
                  <label className="attach-resume" title="Attach your résumé (PDF) to this email">
                    <input
                      type="checkbox"
                      checked={attachResume}
                      disabled={busy}
                      onChange={(e) => setAttachResume(e.target.checked)}
                    />
                    <Paperclip size={13} aria-hidden /> Attach résumé
                  </label>
                )}
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
                      disabled={busy || sendDisabled || !when}
                      onClick={async () => {
                        const iso = new Date(when).toISOString();
                        if (new Date(iso).getTime() <= Date.now()) {
                          toast.error('Pick a time in the future.');
                          return;
                        }
                        await onSchedule(touchIndex, iso, attachResume);
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
