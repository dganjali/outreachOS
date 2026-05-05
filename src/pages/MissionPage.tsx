import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { agents } from '../lib/api';
import { CsvImport } from '../components/CsvImport';
import { SequenceCard } from '../components/SequenceCard';
import type {
  Mission,
  Target,
  Contact,
  EvidencePack,
  EmailSequence,
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
  const [mission, setMission] = useState<Mission | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [contactsByTarget, setContactsByTarget] = useState<Record<string, Contact[]>>({});
  const [packsByTarget, setPacksByTarget] = useState<Record<string, EvidencePack | undefined>>({});
  const [sequencesByContact, setSequencesByContact] = useState<Record<string, EmailSequence | undefined>>({});
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
    setSequencesByContact((s) => ({ ...s, [contactId]: (data as EmailSequence | null) ?? undefined }));
  }, []);

  useEffect(() => {
    loadMission();
    loadTargets();
  }, [loadMission, loadTargets]);

  useEffect(() => {
    targets.forEach((t) => {
      loadContactsForTarget(t.id);
      loadEvidenceForTarget(t.id);
    });
  }, [targets, loadContactsForTarget, loadEvidenceForTarget]);

  const allContacts = useMemo(
    () => Object.values(contactsByTarget).flat(),
    [contactsByTarget]
  );

  useEffect(() => {
    allContacts.forEach((c) => {
      if (sequencesByContact[c.id] === undefined) loadSequencesForContact(c.id);
    });
  }, [allContacts, sequencesByContact, loadSequencesForContact]);

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
    await supabase.from('targets').update({ status }).eq('id', target.id);
    setTargets((ts) => ts.map((t) => (t.id === target.id ? { ...t, status } : t)));
  }

  async function deleteTarget(target: Target) {
    if (!confirm(`Remove ${target.company_name}?`)) return;
    await supabase.from('targets').delete().eq('id', target.id);
    setTargets((ts) => ts.filter((t) => t.id !== target.id));
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
            className="btn-primary"
            disabled={busy === 'targeting'}
            onClick={findTargets}
          >
            {busy === 'targeting' ? 'Researching…' : targets.length === 0 ? 'Find targets' : 'Find more targets'}
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

      {error && (
        <div className="banner-error" role="alert">
          {error}
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: '0.75rem' }}>Targets</h2>
        {targets.length === 0 ? (
          <div className="empty-card">
            <p>No targets yet. Click <strong>Find targets</strong> to have the agent research and rank companies based on your mission.</p>
          </div>
        ) : (
          <div className="target-list">
            {targets.map((t) => {
              const contacts = contactsByTarget[t.id] ?? [];
              const pack = packsByTarget[t.id];
              const isActive = activeTargetId === t.id;
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
                      {typeof t.score === 'number' && (
                        <span className="target-score" title="Fit score">
                          {t.score}
                        </span>
                      )}
                      {t.signal_type && <span className="signal-pill">{t.signal_type}</span>}
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

                  <div className="target-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy === `evidence:${t.id}`}
                      onClick={() => buildEvidence(t)}
                    >
                      {busy === `evidence:${t.id}` ? 'Researching…' : pack ? 'Refresh evidence' : 'Build evidence pack'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy === `contacts:${t.id}`}
                      onClick={() => findContacts(t)}
                    >
                      {busy === `contacts:${t.id}` ? 'Searching…' : contacts.length > 0 ? 'Find more contacts' : 'Find contacts'}
                    </button>
                  </div>

                  {pack && pack.bullets.length > 0 && (
                    <div className="evidence-pack">
                      <div className="evidence-pack-title">Evidence pack</div>
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
                    </div>
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
                              </div>
                              <div className="contact-row-actions">
                                {c.linkedin_url && (
                                  <a href={c.linkedin_url} target="_blank" rel="noreferrer" className="link-pill">
                                    LinkedIn ↗
                                  </a>
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
                            {c.email && <div className="contact-email">{c.email}</div>}
                            {!c.email && c.likely_email_pattern && (
                              <div className="contact-email muted">Pattern: {c.likely_email_pattern}</div>
                            )}
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

