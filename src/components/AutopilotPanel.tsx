import { useEffect, useState } from 'react';
import { autopilot, type AutopilotPolicyView, type AutopilotPatch } from '../lib/api';

// Compact per-mission Autopilot control. Lets the user approve a *policy*
// (discover N targets/week, auto-send gate-cleared drafts within guardrails)
// instead of approving every email. The server cron acts on this policy.
export function AutopilotPanel({ missionId }: { missionId: string }) {
  const [policy, setPolicy] = useState<AutopilotPolicyView | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    autopilot
      .get(missionId)
      .then(({ data }) => {
        if (!cancelled) setPolicy(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  async function patch(p: AutopilotPatch) {
    if (!policy) return;
    setPolicy({ ...policy, ...p }); // optimistic
    setSaving(true);
    setError(null);
    try {
      const { data } = await autopilot.save(missionId, p);
      setPolicy(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  if (!policy) return null;

  return (
    <section className="mission-overview-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <strong style={{ display: 'block' }}>Autopilot</strong>
          <span className="mission-detail-meta" style={{ margin: 0 }}>
            {policy.enabled
              ? policy.auto_send
                ? 'Researching new targets and sending gate-cleared drafts on your behalf.'
                : 'Researching new targets and drafting — nothing sends until you turn on auto-send.'
              : 'Off. Turn on to let the agent keep your pipeline full automatically.'}
          </span>
        </div>
        <Toggle checked={policy.enabled} onChange={(v) => patch({ enabled: v })} label="Enable autopilot" />
      </div>

      {policy.enabled && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Field label="Discover targets / week">
            <input
              type="number"
              min={0}
              max={200}
              value={policy.targets_per_week}
              onChange={(e) => patch({ targets_per_week: Number(e.target.value) })}
              className="input"
            />
          </Field>

          <Field label="Min contact confidence">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(policy.min_contact_confidence * 100)}
                onChange={(e) => patch({ min_contact_confidence: Number(e.target.value) / 100 })}
                style={{ flex: 1 }}
              />
              <span style={{ width: 36, textAlign: 'right' }}>{Math.round(policy.min_contact_confidence * 100)}%</span>
            </div>
          </Field>

          <Field label="Require verified email">
            <Toggle
              checked={policy.require_verified_email}
              onChange={(v) => patch({ require_verified_email: v })}
              label="Require verified email"
            />
          </Field>

          <Field label="Auto-send (not just draft)">
            <Toggle checked={policy.auto_send} onChange={(v) => patch({ auto_send: v })} label="Auto-send" />
          </Field>

          {policy.auto_send && (
            <>
              <Field label="Max sends / day">
                <input
                  type="number"
                  min={0}
                  max={500}
                  value={policy.max_sends_per_day}
                  onChange={(e) => patch({ max_sends_per_day: Number(e.target.value) })}
                  className="input"
                />
              </Field>
              <Field label="Send window (UTC hours)">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={policy.send_window_start_hour}
                    onChange={(e) => patch({ send_window_start_hour: Number(e.target.value) })}
                    className="input"
                    style={{ width: 64 }}
                  />
                  <span>to</span>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={policy.send_window_end_hour}
                    onChange={(e) => patch({ send_window_end_hour: Number(e.target.value) })}
                    className="input"
                    style={{ width: 64 }}
                  />
                </div>
              </Field>
            </>
          )}
        </div>
      )}

      <div className="mission-detail-meta" style={{ margin: 0, minHeight: 16 }}>
        {error ? <span className="run-banner error" style={{ padding: '2px 6px' }}>{error}</span> : saving ? 'Saving…' : policy.last_sweep_at ? `Last checked ${new Date(policy.last_sweep_at).toLocaleString()}` : ''}
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
      <span style={{ opacity: 0.75 }}>{label}</span>
      {children}
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        width: 44,
        height: 26,
        borderRadius: 999,
        border: '1px solid var(--border, #d8d2c4)',
        background: checked ? 'var(--accent, #2f5d4f)' : 'transparent',
        position: 'relative',
        cursor: 'pointer',
        transition: 'background 120ms ease',
        flex: '0 0 auto',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 20 : 2,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: checked ? '#fff' : 'var(--accent, #2f5d4f)',
          transition: 'left 120ms ease',
        }}
      />
    </button>
  );
}
