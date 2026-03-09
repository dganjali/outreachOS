import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { Mission, Target, Contact, EmailDraft } from '../types';

export function MissionPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [mission, setMission] = useState<Mission | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [emails, setEmails] = useState<EmailDraft[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id || !user?.id) return;
    supabase
      .from('missions')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()
      .then(({ data }) => setMission(data as Mission | null));
  }, [id, user?.id]);

  useEffect(() => {
    if (!id) return;
    supabase
      .from('targets')
      .select('*')
      .eq('mission_id', id)
      .then(({ data }) => setTargets(data ?? []));
  }, [id]);

  useEffect(() => {
    if (targets.length === 0) {
      setContacts([]);
      return;
    }
    const targetIds = targets.map((t) => t.id);
    supabase
      .from('contacts')
      .select('*')
      .in('target_id', targetIds)
      .then(({ data }) => setContacts(data ?? []));
  }, [targets]);

  useEffect(() => {
    if (contacts.length === 0) {
      setEmails([]);
      return;
    }
    const contactIds = contacts.map((c) => c.id);
    supabase
      .from('emails')
      .select('*')
      .in('contact_id', contactIds)
      .then(({ data }) => setEmails(data ?? []));
  }, [contacts]);

  useEffect(() => {
    setLoading(false);
  }, [mission]);

  if (loading || !mission) {
    return <p style={{ color: 'var(--text-muted)' }}>Loading…</p>;
  }

  return (
    <div>
      <Link to="/missions" className="mission-detail-back">
        ← Missions
      </Link>
      <h1>{mission.name}</h1>

      <div className="mission-overview-card">
        <h2>Mission overview</h2>
        <div className="mission-overview-row">
          <strong>What you’re sending</strong>
          <span>{mission.goal}</span>
        </div>
        <div className="mission-overview-row">
          <strong>Who you want to send it to (the why)</strong>
          <span>{mission.target_description}</span>
        </div>
        <div className="mission-overview-row">
          <strong>Status</strong>
          <span>{mission.status}</span>
        </div>
      </div>

      <div className="mission-ai-placeholder">
        <h2>What AI will do (coming soon)</h2>
        <p>Once this is enabled, the system will:</p>
        <ul>
          <li>Find people to send your message to</li>
          <li>Personalize emails using your profile and templates</li>
          <li>Handle follow-ups and reply routing</li>
          <li>Find and use info about each person to improve outreach</li>
        </ul>
      </div>

      <section>
        <h2>Targets</h2>
        {targets.length === 0 ? (
          <p style={{ fontSize: '0.9375rem', color: 'var(--text-muted)' }}>
            No targets yet. AI will suggest targets here once that’s enabled.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {targets.map((t) => (
              <li key={t.id}>{t.company_name}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Contacts</h2>
        {contacts.length === 0 ? (
          <p style={{ fontSize: '0.9375rem', color: 'var(--text-muted)' }}>
            No contacts yet. AI will find contacts per target once that’s enabled.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9375rem' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>Name</th>
                <th style={{ textAlign: 'left', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>Role</th>
                <th style={{ textAlign: 'left', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>Company</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => {
                const target = targets.find((t) => t.id === c.target_id);
                return (
                  <tr key={c.id}>
                    <td style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>{c.name}</td>
                    <td style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>{c.role}</td>
                    <td style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>{target?.company_name ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Email drafts</h2>
        {emails.length === 0 ? (
          <p style={{ fontSize: '0.9375rem', color: 'var(--text-muted)' }}>
            No drafts yet. AI will generate personalized drafts once that’s enabled.
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
            {emails.map((e) => (
              <li key={e.id} style={{ marginBottom: '0.5rem' }}>
                <strong>{e.subject}</strong>
                <pre style={{ margin: '0.25rem 0 0', whiteSpace: 'pre-wrap', fontSize: '0.875rem', color: 'var(--text-muted)' }}>{e.body}</pre>
                <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Status: {e.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Replies</h2>
        <p style={{ fontSize: '0.9375rem', color: 'var(--text-muted)' }}>
          Reply tracking and routing will appear here once AI follow-ups are enabled.
        </p>
      </section>
    </div>
  );
}
