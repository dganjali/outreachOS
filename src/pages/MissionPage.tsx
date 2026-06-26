import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  Send, Sparkles, Lock, Undo2, Paperclip, Pencil,
  Plane, PlaneTakeoff, Radar, Search, Users, PenLine, Clock, Eye, MessageSquare, Check, ChevronRight, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { agents, gmail } from '../lib/api';
import { isPaidPlan } from '../../shared/plans';
import { asScore } from '../lib/score';
import { CsvImport } from '../components/CsvImport';
import type {
  Mission,
  Target,
  Contact,
  EvidencePack,
  EmailSequence,
  SentMessage,
  Reply,
  CampaignPolicy,
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

// First-write defaults for a mission's Autopilot policy. Everything the user
// never configures directly; the cron normalizes missing fields too.
const AP_DEFAULTS = {
  auto_send: false,
  targets_per_cycle: 5,
  cycle_interval_hours: 24,
  daily_send_cap: 10,
  send_window: { start_hour: 9, end_hour: 17 },
  timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'America/Toronto',
  min_confidence: 0.6,
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
  // Per-contact activity timeline sources (sent emails + inbound replies).
  const [sentByContact, setSentByContact] = useState<Record<string, SentMessage[]>>({});
  const [repliesByContact, setRepliesByContact] = useState<Record<string, Reply[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the user has a résumé on file - gates the "Attach résumé" send option.
  const [hasResume, setHasResume] = useState(false);
  // Autopilot (paid). The mission page renders as a hands-off status "cockpit"
  // when this policy is enabled, and as the manual action console otherwise.
  const paid = isPaidPlan(profile?.plan, profile?.plan_status);
  const [policy, setPolicy] = useState<CampaignPolicy | null>(null);

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

  const loadPolicy = useCallback(async () => {
    if (!id) return;
    const { data } = await supabase.from('campaign_policies').select('*').eq('mission_id', id).maybeSingle();
    setPolicy((data as CampaignPolicy | null) ?? null);
  }, [id]);

  useEffect(() => {
    loadMission();
    loadTargets();
    loadPolicy();
  }, [loadMission, loadTargets, loadPolicy]);

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

  // Activity-timeline sources: every sent/scheduled email and every inbound
  // reply for the mission's contacts, batched into two requests. Powers the
  // per-contact "Activity" log (so a campaign can be resumed days later).
  useEffect(() => {
    const ids = contactIdsKey ? contactIdsKey.split(',') : [];
    if (ids.length === 0) {
      setSentByContact({});
      setRepliesByContact({});
      return;
    }
    let cancelled = false;
    (async () => {
      const [sentRes, repRes] = await Promise.all([
        supabase
          .from('sent_messages')
          .select('id, contact_id, touch_index, subject, status, scheduled_send_at, sent_at, created_at')
          .in('contact_id', ids),
        supabase
          .from('replies')
          .select('id, contact_id, subject, snippet, received_at, created_at')
          .in('contact_id', ids),
      ]);
      if (cancelled) return;
      const sBy: Record<string, SentMessage[]> = {};
      for (const m of (sentRes.data ?? []) as SentMessage[]) (sBy[m.contact_id] ??= []).push(m);
      setSentByContact(sBy);
      const rBy: Record<string, Reply[]> = {};
      for (const r of (repRes.data ?? []) as Reply[]) (rBy[r.contact_id] ??= []).push(r);
      setRepliesByContact(rBy);
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
    const r = await runWith(`contacts:${target.id}`, () => agents.contacts(target.id));
    if (r) await loadContactsForTarget(target.id);
  }

  async function buildEvidence(target: Target) {
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

  // Flip Autopilot on/off. Free users are routed to the upgrade page instead of
  // toggling anything. First enable creates the policy row with sane defaults.
  async function toggleAutopilot() {
    if (!paid) {
      navigate('/settings');
      return;
    }
    if (!id) return;
    try {
      if (!policy) {
        const { data, error } = await supabase
          .from('campaign_policies')
          .insert({ mission_id: id, enabled: true, ...AP_DEFAULTS })
          .select('*')
          .single();
        if (error) throw new Error(error.message);
        setPolicy(data as CampaignPolicy);
        toast.success('Autopilot on. It starts sourcing and drafting on its next cycle.');
      } else {
        const next = !policy.enabled;
        const { error } = await supabase.from('campaign_policies').update({ enabled: next }).eq('id', policy.id);
        if (error) throw new Error(error.message);
        setPolicy({ ...policy, enabled: next });
        toast.success(next ? 'Autopilot on.' : 'Autopilot off. You are back in manual control.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update Autopilot');
    }
  }

  // Throttle controls (review-first vs auto-send, daily cap). Optimistic with a
  // rollback on failure so the cockpit toggles feel instant.
  async function saveAutopilotField(patch: Partial<CampaignPolicy>) {
    if (!policy) return;
    const prev = policy;
    setPolicy({ ...policy, ...patch });
    const { error } = await supabase.from('campaign_policies').update(patch).eq('id', policy.id);
    if (error) {
      toast.error(error.message);
      setPolicy(prev);
    }
  }

  if (!mission) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;
  }

  const totalContacts = allContacts.length;
  const totalDrafts = Object.values(sequencesByContact).filter(Boolean).length;
  // Companies the pipeline dropped for having no reachable contact are marked
  // 'rejected' - keep them out of the output so the user only sees real targets.
  const visibleTargets = targets.filter((t) => t.status !== 'rejected');

  // Whether to render the hands-off Autopilot cockpit (paid + enabled) vs. the
  // manual action console.
  const autopilotOn = paid && !!policy?.enabled;

  // Cross-mission counts that feed the cockpit instruments. All derived from
  // state we already load - no extra queries.
  const allSent = Object.values(sentByContact).flat();
  const sentCount = allSent.filter((m) => m.status === 'sent').length;
  const scheduledCount = allSent.filter((m) => m.status === 'queued').length;
  const repliesCount = allContacts.filter((c) => c.status === 'replied').length;
  const sentToday =
    policy?.counter && policy.counter.date === new Date().toISOString().slice(0, 10) ? policy.counter.sent : 0;

  // Drafts Autopilot wrote but is holding for the user (low confidence /
  // unverified address, or review-first mode) - the one actionable list in the
  // cockpit. Already-sent ones drop off.
  const reviewItems: Array<{ target: Target; contact: Contact; sequence: EmailSequence }> = [];
  for (const t of visibleTargets) {
    for (const c of contactsByTarget[t.id] ?? []) {
      const seq = sequencesByContact[c.id];
      if (!seq) continue;
      if ((seq.autopilot_state === 'ready' || seq.autopilot_state === 'review') && !initialSentSeqIds.has(seq.id)) {
        reviewItems.push({ target: t, contact: c, sequence: seq });
      }
    }
  }

  const metrics = {
    targets: visibleTargets.length,
    contacts: totalContacts,
    drafts: totalDrafts,
    sent: sentCount,
    scheduled: scheduledCount,
    replies: repliesCount,
    review: reviewItems.length,
  };

  // One "flight" per company for the cockpit Airspace view: how far each has
  // travelled down the pipeline (sourced → researched → contacted → drafted →
  // sent → replied), mapped to a position + flight phase.
  const flights: Flight[] = visibleTargets
    .map((t): Flight => {
      const cs = contactsByTarget[t.id] ?? [];
      const repliedN = cs.filter((c) => c.status === 'replied').length;
      const sentN = cs.filter((c) => {
        const s = sequencesByContact[c.id];
        return (s && initialSentSeqIds.has(s.id)) || c.status === 'contacted';
      }).length;
      const draftsN = cs.filter((c) => sequencesByContact[c.id]).length;
      const pack = packsByTarget[t.id];

      let progress = 12;
      let phase = 'Taxiing';
      let tone = 'taxi';
      let stage: Flight['stage'] = 'sourced';
      let note = 'Sourced — researching next.';
      if (repliedN > 0) {
        progress = 100; phase = 'Landed'; tone = 'landed'; stage = 'replied';
        note = `${repliedN} repl${repliedN === 1 ? 'y' : 'ies'} in. Follow-ups paused.`;
      } else if (sentN > 0) {
        progress = 86; phase = 'Descending'; tone = 'sent'; stage = 'sent';
        note = `${sentN} email${sentN === 1 ? '' : 's'} sent — awaiting a reply.`;
      } else if (draftsN > 0) {
        progress = 66; phase = 'Cruising'; tone = 'cruise'; stage = 'drafted';
        note = `${draftsN} draft${draftsN === 1 ? '' : 's'} ready to send.`;
      } else if (cs.length) {
        progress = 46; phase = 'Climbing'; tone = 'climb'; stage = 'contacts';
        note = `${cs.length} contact${cs.length === 1 ? '' : 's'} found — drafting outreach.`;
      } else if (pack) {
        progress = 30; phase = 'Climbing'; tone = 'climb'; stage = 'researched';
        note = 'Researched — finding the right contacts.';
      }
      return {
        id: t.id, name: t.company_name, signal: t.signal_type ?? null,
        progress, phase, tone, stage, note,
        contacts: cs.length, drafts: draftsN, sent: sentN, replied: repliedN,
      };
    })
    .sort((a, b) => b.progress - a.progress || a.name.localeCompare(b.name));

  return (
    <div className="mx">
      <MissionTopbar
        mission={mission}
        metrics={metrics}
        paid={paid}
        autopilotOn={autopilotOn}
        onToggleAutopilot={toggleAutopilot}
        onRun={() => navigate(`/missions/${mission.id}/run`)}
      />

      <MissionBriefCard mission={mission} onSaved={loadMission} />

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      {autopilotOn && policy ? (
        <AutopilotCockpit
          policy={policy}
          metrics={metrics}
          sentToday={sentToday}
          flights={flights}
          reviewItems={reviewItems}
          refreshKey={refreshKey}
          aiEnabled={aiEnabled}
          hasResume={hasResume}
          onSaveField={saveAutopilotField}
          onReloadContacts={loadContactsForTarget}
          onReloadSequence={loadSequencesForContact}
        />
      ) : (
        <>
          <section className="console">
            <div className="console-bar">
              <h2 className="console-title">
                Pipeline
                {visibleTargets.length > 0 && <span className="console-count">{visibleTargets.length}</span>}
              </h2>
              <div className="console-bar-actions">
                {sendableInitials.length > 0 && (
                  <button
                    type="button"
                    className="btn-go btn-launch"
                    disabled={sendingAll}
                    onClick={sendAllInitial}
                    title="Send the initial email to every contact that has a draft and a recipient address"
                  >
                    {sendingAll ? (
                      `Sending ${sendableInitials.length}…`
                    ) : (
                      <>
                        <Send size={14} aria-hidden /> Send all ({sendableInitials.length})
                      </>
                    )}
                  </button>
                )}
                <CsvImport missionId={mission.id} onImported={loadTargets} />
                {visibleTargets.length > 0 && (
                  <button type="button" className="btn-secondary" disabled={busy === 'targeting'} onClick={findTargets}>
                    {busy === 'targeting' ? 'Researching…' : 'Find more'}
                  </button>
                )}
              </div>
            </div>

            {visibleTargets.length === 0 ? (
              <div className="empty-illo">
                <div className="empty-illo-graphic" aria-hidden>
                  <Radar size={28} />
                </div>
                <h3>No companies yet</h3>
                <p>
                  Run the pipeline to find companies, research them, surface the right people, and draft outreach —
                  live, in one pass. Or drive each step yourself.
                </p>
                <div className="empty-illo-actions">
                  <button type="button" className="btn-go" onClick={() => navigate(`/missions/${mission.id}/run`)}>
                    Run pipeline
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy === 'targeting'} onClick={findTargets}>
                    {busy === 'targeting' ? 'Researching…' : 'Find companies'}
                  </button>
                </div>
              </div>
            ) : (
              <ul className="tgt-list">
                {visibleTargets.map((t) => (
                  <TargetRow
                    key={t.id}
                    target={t}
                    contacts={contactsByTarget[t.id] ?? []}
                    pack={packsByTarget[t.id]}
                    sequencesByContact={sequencesByContact}
                    initialSentSeqIds={initialSentSeqIds}
                    sentByContact={sentByContact}
                    repliesByContact={repliesByContact}
                    refreshKey={refreshKey}
                    busy={busy}
                    aiEnabled={aiEnabled}
                    hasResume={hasResume}
                    selectedContactIds={selectedContactIds}
                    onBuildEvidence={buildEvidence}
                    onFindContacts={findContacts}
                    onGenerateSequence={generateSequence}
                    onSetStatus={setTargetStatus}
                    onDelete={deleteTarget}
                    onMarkReplied={markContactReplied}
                    onToggleSelected={toggleContactSelected}
                    onReloadContacts={loadContactsForTarget}
                    onReloadSequence={loadSequencesForContact}
                  />
                ))}
              </ul>
            )}
          </section>

          {selectedContactIds.size > 0 && (
            <div className="bulk-action-bar" role="region" aria-label="Bulk contact actions">
              <span className="bulk-count">
                {selectedContactIds.size} contact{selectedContactIds.size === 1 ? '' : 's'} selected
              </span>
              <div className="bulk-actions">
                <button type="button" className="btn-secondary small" disabled={bulkBusy} onClick={() => bulkSetContactStatus('approved')}>
                  Approve
                </button>
                <button type="button" className="btn-secondary small" disabled={bulkBusy} onClick={() => bulkSetContactStatus('contacted')}>
                  Mark contacted
                </button>
                <button type="button" className="btn-secondary small bulk-danger" disabled={bulkBusy} onClick={() => bulkSetContactStatus('rejected')}>
                  Reject
                </button>
                <button type="button" className="link-button" disabled={bulkBusy} onClick={clearSelection}>
                  Clear
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topbar: compact identity + live stat strip + the Autopilot switch (the one
// control that flips the whole page between manual console and cockpit).
// ---------------------------------------------------------------------------
type Metrics = {
  targets: number;
  contacts: number;
  drafts: number;
  sent: number;
  scheduled: number;
  replies: number;
  review: number;
};

// One company in Autopilot's airspace — a cloud the user can click to see what
// Autopilot is doing with it. `stage` picks the cloud's status icon; `progress`
// only seeds its starting position in the drift.
type Flight = {
  id: string;
  name: string;
  signal: string | null;
  progress: number;
  phase: string;
  tone: string;
  stage: 'sourced' | 'researched' | 'contacts' | 'drafted' | 'sent' | 'replied';
  note: string;
  contacts: number;
  drafts: number;
  sent: number;
  replied: number;
};

function MissionTopbar({
  mission,
  metrics,
  paid,
  autopilotOn,
  onToggleAutopilot,
  onRun,
}: {
  mission: Mission;
  metrics: Metrics;
  paid: boolean;
  autopilotOn: boolean;
  onToggleAutopilot: () => void;
  onRun: () => void;
}) {
  return (
    <header className="mtop">
      <div className="mtop-left">
        <Link to="/missions" className="mtop-back">
          ← Missions
        </Link>
        <div className="mtop-title">
          <h1>{mission.name}</h1>
          <div className="mtop-meta">
            <span className="mode-pill">{MODE_LABEL[mission.mode] ?? mission.mode}</span>
            <span className="mtop-stats">
              <span>{metrics.targets} targets</span>
              <span>{metrics.contacts} contacts</span>
              <span>{metrics.sent} sent</span>
            </span>
          </div>
        </div>
      </div>
      <div className="mtop-actions">
        <ModeSwitch paid={paid} on={autopilotOn} onToggle={onToggleAutopilot} />
        {!autopilotOn && (
          <button
            type="button"
            className="btn-go btn-launch"
            onClick={onRun}
            title="Find companies, research them, surface contacts, and draft initial emails, live."
          >
            <PlaneTakeoff size={15} aria-hidden /> Run pipeline
          </button>
        )}
      </div>
    </header>
  );
}

// Segmented Manual / Autopilot switch. Names both modes and shows which is
// active; the active Autopilot segment carries the one sparing green accent.
// For free users the Autopilot segment is a locked Pro upsell.
function ModeSwitch({ paid, on, onToggle }: { paid: boolean; on: boolean; onToggle: () => void }) {
  return (
    <div className="ms" role="group" aria-label="Mission mode">
      <button
        type="button"
        className={`ms-seg${!on ? ' is-active' : ''}`}
        aria-pressed={!on}
        onClick={() => on && onToggle()}
      >
        Manual
      </button>
      <button
        type="button"
        className={`ms-seg ms-seg-auto${on ? ' is-active' : ''}${!paid ? ' is-locked' : ''}`}
        aria-pressed={on}
        onClick={() => (paid ? !on && onToggle() : onToggle())}
        title={paid ? 'Hand this mission to Autopilot' : 'Autopilot is a paid feature'}
      >
        {!paid ? <Lock size={12} aria-hidden /> : <Plane size={13} aria-hidden />}
        Autopilot
        {!paid && <span className="ms-pro">Pro</span>}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Autopilot cockpit (paid, enabled): a hands-off flight deck. Instruments show
// the state of everything; the only controls are the throttle, and the only
// action is clearing drafts Autopilot held for review.
// ---------------------------------------------------------------------------
function AutopilotCockpit({
  policy,
  metrics,
  sentToday,
  flights,
  reviewItems,
  refreshKey,
  aiEnabled,
  hasResume,
  onSaveField,
  onReloadContacts,
  onReloadSequence,
}: {
  policy: CampaignPolicy;
  metrics: Metrics;
  sentToday: number;
  flights: Flight[];
  reviewItems: Array<{ target: Target; contact: Contact; sequence: EmailSequence }>;
  refreshKey: number;
  aiEnabled: boolean;
  hasResume: boolean;
  onSaveField: (patch: Partial<CampaignPolicy>) => void | Promise<void>;
  onReloadContacts: (targetId: string) => void | Promise<void>;
  onReloadSequence: (contactId: string) => void | Promise<void>;
}) {
  const [capDraft, setCapDraft] = useState(String(policy.daily_send_cap));

  // Flight phase drives the headline + lamp. Holding (someone must act) > taxiing
  // (enabled, nothing sourced yet) > cruising (running normally).
  const phase: 'holding' | 'taxiing' | 'cruising' =
    metrics.review > 0
      ? 'holding'
      : !policy.last_sourced_at && metrics.contacts === 0 && metrics.drafts === 0
        ? 'taxiing'
        : 'cruising';
  const phaseLabel =
    phase === 'holding' ? 'Holding for review' : phase === 'taxiing' ? 'Taxiing — preparing first batch' : 'Cruising';
  const cadence = `${
    policy.last_sourced_at ? `Last run ${relativeTime(policy.last_sourced_at)}` : 'First run on the next cycle'
  } · checks every ${policy.cycle_interval_hours ?? 24}h`;

  return (
    <div className="cockpit">
      <Skyfield phase={phase} phaseLabel={phaseLabel} cadence={cadence} flights={flights} />

      <div className="cockpit-gauges">
        <Gauge icon={<Radar size={15} />} label="Sourced" value={metrics.targets} />
        <Gauge icon={<Users size={15} />} label="Contacts" value={metrics.contacts} />
        <Gauge icon={<PenLine size={15} />} label="Drafted" value={metrics.drafts} />
        <Gauge icon={<Send size={15} />} label="Sent" value={metrics.sent} sub={sentToday ? `${sentToday} today` : undefined} />
        <Gauge icon={<Clock size={15} />} label="Scheduled" value={metrics.scheduled} />
        <Gauge icon={<Eye size={15} />} label="To review" value={metrics.review} alert={metrics.review > 0} />
        <Gauge icon={<MessageSquare size={15} />} label="Replies" value={metrics.replies} />
      </div>

      <div className="cockpit-throttle">
        <div className="cockpit-throttle-label">When a draft is ready</div>
        <div className="ap-choices">
          <button
            type="button"
            className={`ap-choice${!policy.auto_send ? ' is-on' : ''}`}
            onClick={() => onSaveField({ auto_send: false })}
            aria-pressed={!policy.auto_send}
          >
            {!policy.auto_send && (
              <span className="ap-choice-check">
                <Check size={12} />
              </span>
            )}
            <span className="ap-choice-title">Review first</span>
            <span className="ap-choice-hint">Autopilot drafts and waits. You approve every send.</span>
          </button>
          <button
            type="button"
            className={`ap-choice${policy.auto_send ? ' is-on' : ''}`}
            onClick={() => onSaveField({ auto_send: true })}
            aria-pressed={policy.auto_send}
          >
            {policy.auto_send && (
              <span className="ap-choice-check">
                <Check size={12} />
              </span>
            )}
            <span className="ap-choice-title">Send automatically</span>
            <span className="ap-choice-hint">Sends verified, high-confidence contacts. Holds the rest for review.</span>
          </button>
        </div>
        {policy.auto_send && (
          <label className="cockpit-cap">
            <span>Send at most</span>
            <input
              type="number"
              min={1}
              max={100}
              value={capDraft}
              onChange={(e) => setCapDraft(e.target.value)}
              onBlur={() => onSaveField({ daily_send_cap: clampCap(capDraft) })}
            />
            <span>emails / day</span>
          </label>
        )}
      </div>

      {reviewItems.length > 0 && (
        <section className="cockpit-review">
          <div className="cockpit-review-head">
            <Eye size={15} aria-hidden />
            <span>Awaiting your clearance</span>
            <span className="console-count">{reviewItems.length}</span>
          </div>
          <div className="cockpit-review-list">
            {reviewItems.map(({ target, contact, sequence }) => (
              <div key={sequence.id} className="cockpit-review-item">
                <div className="cri-id">
                  <strong>{contact.name}</strong>
                  <span className="pc-role">{contact.role}</span>
                  <span className="cri-co">{target.company_name}</span>
                </div>
                <SequenceCard
                  key={`${sequence.id}:${refreshKey}`}
                  sequence={sequence}
                  contact={contact}
                  aiEnabled={aiEnabled}
                  hasResume={hasResume}
                  onContactUpdated={() => onReloadContacts(target.id)}
                  onSequenceUpdated={() => onReloadSequence(contact.id)}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="cockpit-note">
        Autopilot only sends to verified addresses, during business hours, and sources a few new companies a day.
        Low-confidence drafts always wait here for you. Switch to <strong>Manual</strong> any time, up top.
      </p>
    </div>
  );
}

// The flight view: one hero plane and a calm sky, with each company drifting
// past as a labelled cloud you can click to see what Autopilot is doing with it.
// Vertical lanes keep the clouds from stacking; the (negative) per-cloud
// animation delay spreads them across the drift so they never clump.
const SKY_LANES = [14, 38, 60, 26, 50, 18, 44, 64, 32, 56, 22, 48, 36, 12];

function Skyfield({
  phase,
  phaseLabel,
  cadence,
  flights,
}: {
  phase: 'holding' | 'taxiing' | 'cruising';
  phaseLabel: string;
  cadence: string;
  flights: Flight[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keep the sky calm: a few new companies a day means this rarely overflows,
  // but cap it so the scene never turns into a swarm. The rest stay in the gauges.
  const clouds = flights.slice(0, 14);
  const selected = flights.find((f) => f.id === selectedId) ?? null;

  return (
    <div className="sky">
      <div className={`sky-scene phase-${phase}`} onClick={() => setSelectedId(null)}>
        <div className="sky-status">
          <span className="sky-status-kicker">Autopilot</span>
          <span className="sky-status-phase">{phaseLabel}</span>
          <span className="sky-status-cadence">{cadence}</span>
          <span className="sky-lamp">
            <span className="sky-lamp-dot" aria-hidden />
            Engaged
          </span>
        </div>

        <div className="sky-hero" aria-hidden>
          <span className="sky-hero-trail" />
          <Plane size={34} />
        </div>

        {clouds.map((f, i) => (
          <button
            key={f.id}
            type="button"
            className={`cloud stage-${f.stage} tone-${f.tone}${selectedId === f.id ? ' is-selected' : ''}`}
            style={
              {
                top: `${SKY_LANES[i % SKY_LANES.length]}%`,
                left: `${f.progress}%`,
                '--i': i,
                '--n': clouds.length,
              } as CSSProperties
            }
            onClick={(e) => {
              e.stopPropagation();
              setSelectedId((s) => (s === f.id ? null : f.id));
            }}
            title={`${f.name} · ${f.phase}`}
          >
            <span className="cloud-icon" aria-hidden>{stageIcon(f.stage)}</span>
            <span className="cloud-name">{f.name}</span>
          </button>
        ))}

        {flights.length > clouds.length && (
          <span className="sky-more">+{flights.length - clouds.length} more</span>
        )}
      </div>

      {selected && <FlightDetail flight={selected} onClose={() => setSelectedId(null)} />}
    </div>
  );
}

function FlightDetail({ flight, onClose }: { flight: Flight; onClose: () => void }) {
  return (
    <div className={`flight-detail tone-${flight.tone}`}>
      <span className="flight-detail-icon" aria-hidden>{stageIcon(flight.stage)}</span>
      <div className="flight-detail-body">
        <div className="flight-detail-top">
          <strong>{flight.name}</strong>
          {flight.signal && (
            <span className="signal-pill" data-signal={flight.signal}>{flight.signal}</span>
          )}
          <span className="flight-detail-phase">{flight.phase}</span>
        </div>
        <p className="flight-detail-note">{flight.note}</p>
        <div className="flight-detail-stats">
          <span>{flight.contacts} contact{flight.contacts === 1 ? '' : 's'}</span>
          <span>{flight.drafts} draft{flight.drafts === 1 ? '' : 's'}</span>
          <span>{flight.sent} sent</span>
          {flight.replied > 0 && <span>{flight.replied} replied</span>}
        </div>
      </div>
      <button type="button" className="flight-detail-close" onClick={onClose} aria-label="Close">
        <X size={15} />
      </button>
    </div>
  );
}

function stageIcon(stage: Flight['stage']): ReactNode {
  switch (stage) {
    case 'sourced': return <Radar size={13} />;
    case 'researched': return <Search size={13} />;
    case 'contacts': return <Users size={13} />;
    case 'drafted': return <PenLine size={13} />;
    case 'sent': return <Send size={13} />;
    case 'replied': return <MessageSquare size={13} />;
  }
}

function Gauge({
  icon,
  label,
  value,
  sub,
  alert,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <div className={`gauge${alert ? ' is-alert' : ''}`}>
      <span className="gauge-icon" aria-hidden>
        {icon}
      </span>
      <span className="gauge-val">{value}</span>
      <span className="gauge-label">{label}</span>
      {sub && <span className="gauge-sub">{sub}</span>}
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function clampCap(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 10;
  return Math.max(1, Math.min(100, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Manual console: one row per company that leads with the single next action,
// expanding into a clean Research + People workspace. Replaces the old nested
// accordion-in-accordion wall.
// ---------------------------------------------------------------------------
type TargetStage = {
  stage: 'research' | 'contacts' | 'draft' | 'review' | 'done';
  label: string;
  cta: string | null;
};

function targetStage(
  pack: EvidencePack | undefined,
  contacts: Contact[],
  sequencesByContact: Record<string, EmailSequence | null | undefined>,
  initialSentSeqIds: Set<string>,
): TargetStage {
  if (!pack) return { stage: 'research', label: 'Needs research', cta: 'Research' };
  if (contacts.length === 0) return { stage: 'contacts', label: 'Needs contacts', cta: 'Find contacts' };
  const drafted = contacts.filter((c) => sequencesByContact[c.id]);
  if (drafted.length === 0) return { stage: 'draft', label: 'Ready to draft', cta: 'Draft emails' };
  const unsent = drafted.filter((c) => {
    const s = sequencesByContact[c.id];
    return s && !initialSentSeqIds.has(s.id) && c.status !== 'replied';
  });
  if (unsent.length > 0)
    return { stage: 'review', label: `${unsent.length} draft${unsent.length === 1 ? '' : 's'} ready`, cta: 'Review & send' };
  return { stage: 'done', label: 'Contacted', cta: null };
}

function TargetRow({
  target: t,
  contacts,
  pack,
  sequencesByContact,
  initialSentSeqIds,
  sentByContact,
  repliesByContact,
  refreshKey,
  busy,
  aiEnabled,
  hasResume,
  selectedContactIds,
  onBuildEvidence,
  onFindContacts,
  onGenerateSequence,
  onSetStatus,
  onDelete,
  onMarkReplied,
  onToggleSelected,
  onReloadContacts,
  onReloadSequence,
}: {
  target: Target;
  contacts: Contact[];
  pack: EvidencePack | undefined;
  sequencesByContact: Record<string, EmailSequence | null | undefined>;
  initialSentSeqIds: Set<string>;
  sentByContact: Record<string, SentMessage[]>;
  repliesByContact: Record<string, Reply[]>;
  refreshKey: number;
  busy: string | null;
  aiEnabled: boolean;
  hasResume: boolean;
  selectedContactIds: Set<string>;
  onBuildEvidence: (t: Target) => void | Promise<void>;
  onFindContacts: (t: Target) => void | Promise<void>;
  onGenerateSequence: (c: Contact) => void | Promise<void>;
  onSetStatus: (t: Target, status: Target['status']) => void | Promise<void>;
  onDelete: (t: Target) => void | Promise<void>;
  onMarkReplied: (c: Contact) => void | Promise<void>;
  onToggleSelected: (id: string) => void;
  onReloadContacts: (targetId: string) => void | Promise<void>;
  onReloadSequence: (contactId: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const score = asScore(t.score);
  const stage = targetStage(pack, contacts, sequencesByContact, initialSentSeqIds);
  const draftCount = contacts.filter((c) => sequencesByContact[c.id]).length;
  const evidenceBusy = busy === `evidence:${t.id}`;
  const contactsBusy = busy === `contacts:${t.id}`;

  // The next-action button. Run-style stages fire their agent and open the row
  // so progress is visible; expand-style stages just reveal the workspace.
  function runPrimary() {
    setOpen(true);
    if (stage.stage === 'research') onBuildEvidence(t);
    else if (stage.stage === 'contacts') onFindContacts(t);
  }
  const primaryBusy =
    (stage.stage === 'research' && evidenceBusy) || (stage.stage === 'contacts' && contactsBusy);

  return (
    <li className={`tgt status-${t.status}${open ? ' is-open' : ''}`}>
      <div className="tgt-bar">
        <button type="button" className="tgt-main" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronRight size={15} className="tgt-caret" aria-hidden />
          {score != null && (
            <span className="tgt-score" title="Fit score">
              {score}
            </span>
          )}
          <span className="tgt-name">{t.company_name}</span>
          {t.signal_type && (
            <span className="signal-pill" data-signal={t.signal_type}>
              {t.signal_type}
            </span>
          )}
          {t.domain && <span className="tgt-domain">{t.domain}</span>}
        </button>
        <div className="tgt-aside">
          <span className={`tgt-stage stage-${stage.stage}`}>{stage.label}</span>
          {stage.cta && (
            <button type="button" className="btn-primary small tgt-cta" disabled={primaryBusy} onClick={runPrimary}>
              {primaryBusy ? 'Working…' : stage.cta}
            </button>
          )}
        </div>
      </div>

      {open && (
        <div className="tgt-detail">
          <div className="tgt-detail-top">
            <div className="tgt-detail-facts">
              {t.industry && <span>{t.industry}</span>}
              {typeof t.employee_count === 'number' && <span>{t.employee_count.toLocaleString()} ppl</span>}
              {t.domain && (
                <a href={`https://${t.domain}`} target="_blank" rel="noreferrer" className="tgt-visit">
                  Visit ↗
                </a>
              )}
            </div>
            <div className="tgt-detail-controls">
              <select
                className="tgt-status-select"
                value={t.status}
                onChange={(e) => onSetStatus(t, e.target.value as Target['status'])}
                aria-label={`Status for ${t.company_name}`}
              >
                <option value="suggested">Suggested</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="contacted">Contacted</option>
              </select>
              <button
                type="button"
                className="tgt-remove"
                onClick={() => onDelete(t)}
                title={`Remove ${t.company_name}`}
                aria-label={`Remove ${t.company_name}`}
              >
                ×
              </button>
            </div>
          </div>

          {(t.why_now || t.fit_reason) && (
            <div className="tgt-why">
              {t.why_now && (
                <p>
                  <strong>Why now</strong> {t.why_now}
                </p>
              )}
              {t.fit_reason && <p className="tgt-why-fit">{t.fit_reason}</p>}
            </div>
          )}

          {/* Research */}
          <div className="tgt-sec">
            <div className="tgt-sec-head">
              <span className="tgt-sec-title">Research</span>
              <button type="button" className="btn-secondary small" disabled={evidenceBusy} onClick={() => onBuildEvidence(t)}>
                {evidenceBusy ? 'Researching…' : pack ? 'Refresh' : 'Build evidence'}
              </button>
            </div>
            {pack && pack.bullets.length > 0 ? (
              <ol className="ev-list">
                {pack.bullets.map((b, i) => (
                  <li key={i}>
                    <span className="ev-fact">{b.fact}</span>
                    <span className="ev-meta">
                      {b.signal_type && (
                        <span className="signal-pill" data-signal={b.signal_type}>
                          {b.signal_type}
                        </span>
                      )}
                      {b.recency && <span> · {b.recency}</span>}
                      {b.source_url && (
                        <>
                          {' · '}
                          <a href={b.source_url} target="_blank" rel="noreferrer">
                            {b.source_title || 'source'} ↗
                          </a>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="tgt-sec-empty">No evidence yet. Research the company to personalize every email.</p>
            )}
          </div>

          {/* People */}
          <div className="tgt-sec">
            <div className="tgt-sec-head">
              <span className="tgt-sec-title">
                People{contacts.length > 0 && <span className="tgt-sec-count">{contacts.length}</span>}
              </span>
              <button type="button" className="btn-secondary small" disabled={contactsBusy} onClick={() => onFindContacts(t)}>
                {contactsBusy ? 'Searching…' : contacts.length > 0 ? 'Find more' : 'Find contacts'}
              </button>
            </div>
            {contacts.length === 0 ? (
              <p className="tgt-sec-empty">
                {pack
                  ? 'Find the decision-makers, then draft a personalized email to each.'
                  : 'Build evidence first, then find contacts to draft personalized emails to.'}
              </p>
            ) : (
              <div className="ppl">
                {contacts.map((c) => {
                  const seq = sequencesByContact[c.id];
                  return (
                    <div key={c.id} className={`pc${selectedContactIds.has(c.id) ? ' selected' : ''}`}>
                      <div className="pc-head">
                        <input
                          type="checkbox"
                          className="pc-select"
                          checked={selectedContactIds.has(c.id)}
                          onChange={() => onToggleSelected(c.id)}
                          aria-label={`Select ${c.name}`}
                        />
                        <div className="pc-id">
                          <span className="pc-name">
                            <strong>{c.name}</strong>
                            <span className="pc-role">{c.role}</span>
                          </span>
                          {typeof c.confidence === 'number' && (
                            <span
                              className="pc-conf"
                              title="Estimated reply-likelihood — role & seniority fit plus signals. Higher is better."
                            >
                              {Math.round(c.confidence * 100)}%
                            </span>
                          )}
                        </div>
                        <div className="pc-actions">
                          {c.linkedin_url && (
                            <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="link-pill">
                              LinkedIn ↗
                            </a>
                          )}
                          {c.status === 'replied' ? (
                            <span className="status-pill is-success" title="Follow-ups stopped">
                              replied
                            </span>
                          ) : (
                            c.status === 'contacted' && (
                              <button
                                type="button"
                                className="btn-secondary small"
                                title="They wrote back in Gmail - stop their scheduled follow-ups"
                                onClick={() => onMarkReplied(c)}
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
                            onClick={() => onGenerateSequence(c)}
                          >
                            {busy === `sequence:${c.id}` ? 'Drafting…' : seq ? 'Regenerate' : 'Draft email'}
                          </button>
                        </div>
                      </div>
                      {c.email ? (
                        <div className="pc-email">
                          {c.email} <EmailStatusPill status={c.email_status} />
                        </div>
                      ) : (
                        c.likely_email_pattern && <div className="pc-email muted">Pattern: {c.likely_email_pattern}</div>
                      )}
                      {c.headline && <div className="pc-note muted">{c.headline}</div>}
                      {c.reasoning && <div className="pc-note">{c.reasoning}</div>}

                      {seq && (
                        <SequenceCard
                          key={`${seq.id}:${refreshKey}`}
                          sequence={seq}
                          contact={c}
                          aiEnabled={aiEnabled}
                          hasResume={hasResume}
                          onContactUpdated={() => onReloadContacts(t.id)}
                          onSequenceUpdated={() => onReloadSequence(c.id)}
                        />
                      )}
                      <ContactActivity
                        contact={c}
                        sequence={seq}
                        sent={sentByContact[c.id] ?? []}
                        replies={repliesByContact[c.id] ?? []}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// Per-contact activity timeline, synthesized from real timestamps we already
// have: discovery, draft, each sent/scheduled email, and inbound replies. No
// status-change events (we don't store their timestamps) - the current status
// is shown on the row itself.
function fmtActivityTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function ContactActivity({
  contact,
  sequence,
  sent,
  replies,
}: {
  contact: Contact;
  sequence?: EmailSequence | null;
  sent: SentMessage[];
  replies: Reply[];
}) {
  const events = useMemo(() => {
    type Ev = { at: string | null; label: string; detail?: string; kind: string };
    const evs: Ev[] = [];
    const sourceLabel =
      contact.source === 'csv' ? 'Imported from CSV' : contact.source === 'manual' ? 'Added manually' : 'Found via web search';
    evs.push({ at: contact.created_at, kind: 'found', label: 'Contact discovered', detail: sourceLabel });
    if (sequence) evs.push({ at: sequence.created_at, kind: 'draft', label: 'Draft written' });
    for (const m of sent) {
      const touchLabel = m.touch_index === 0 ? 'Initial email' : `Follow-up ${m.touch_index}`;
      if (m.status === 'sent' && m.sent_at) {
        evs.push({ at: m.sent_at, kind: 'sent', label: `${touchLabel} sent`, detail: m.subject });
      } else if ((m.status === 'queued' || m.status === 'draft') && m.scheduled_send_at) {
        evs.push({ at: m.scheduled_send_at, kind: 'scheduled', label: `${touchLabel} scheduled`, detail: m.subject });
      } else if (m.status === 'failed' || m.status === 'bounced') {
        evs.push({ at: m.created_at, kind: 'failed', label: `${touchLabel} ${m.status}`, detail: m.subject });
      }
    }
    for (const r of replies) {
      evs.push({ at: r.received_at || r.created_at, kind: 'reply', label: 'Reply received', detail: r.subject || r.snippet || undefined });
    }
    return evs.sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at).getTime() - new Date(b.at).getTime();
    });
  }, [contact, sequence, sent, replies]);

  // Only "discovered" so far - nothing worth a collapsible timeline yet.
  if (events.length <= 1) return null;

  return (
    <details className="contact-activity">
      <summary>Activity ({events.length})</summary>
      <ol className="activity-timeline">
        {events.map((e, i) => (
          <li key={i} className={`activity-event activity-${e.kind}`}>
            <span className="activity-dot" aria-hidden />
            <span className="activity-body">
              <span className="activity-label">{e.label}</span>
              {e.detail && <span className="activity-detail">{e.detail}</span>}
            </span>
            <time className="activity-time">{fmtActivityTime(e.at)}</time>
          </li>
        ))}
      </ol>
    </details>
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
