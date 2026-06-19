import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { billing } from '../lib/api';
import type { CampaignPolicy } from '../types';
import type { PlanId } from '../../shared/plans';

// Mirrors POLICY_DEFAULTS in api/_lib/autopilot.ts. The cron also normalizes
// missing fields, so these only shape the first-write + the settings form.
const DEFAULTS = {
  auto_send: false,
  targets_per_cycle: 5,
  cycle_interval_hours: 24,
  daily_send_cap: 10,
  send_window: { start_hour: 9, end_hour: 17 },
  timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'America/Toronto',
  min_confidence: 0.6,
};

type Counts = { queued: number; ready: number; review: number };

export function AutopilotPanel({ missionId }: { missionId: string }) {
  const { user } = useAuth();
  const [plan, setPlan] = useState<PlanId | null>(null);
  const [policy, setPolicy] = useState<CampaignPolicy | null>(null);
  const [counts, setCounts] = useState<Counts>({ queued: 0, ready: 0, review: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const loadPolicy = useCallback(async () => {
    const { data } = await supabase
      .from('campaign_policies')
      .select('*')
      .eq('mission_id', missionId)
      .maybeSingle();
    setPolicy((data as CampaignPolicy | null) ?? null);
  }, [missionId]);

  const loadCounts = useCallback(async () => {
    const { data } = await supabase.from('email_sequences').select('*').eq('mission_id', missionId);
    const c: Counts = { queued: 0, ready: 0, review: 0 };
    for (const s of (data ?? []) as Array<{ autopilot_state?: string | null }>) {
      if (s.autopilot_state === 'queued') c.queued++;
      else if (s.autopilot_state === 'ready') c.ready++;
      else if (s.autopilot_state === 'review') c.review++;
    }
    setCounts(c);
  }, [missionId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [me] = await Promise.all([billing.me(), loadPolicy(), loadCounts()]);
        if (alive) setPlan(me.plan);
      } catch {
        if (alive) setPlan('free');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loadPolicy, loadCounts]);

  const paid = plan !== null && plan !== 'free';

  async function toggleEnabled() {
    if (!user?.id) return;
    setBusy(true);
    try {
      if (!policy) {
        await supabase.from('campaign_policies').insert({
          mission_id: missionId,
          enabled: true,
          ...DEFAULTS,
        });
        toast.success('Autopilot on. It will source, draft, and gate on its next cycle.');
      } else {
        const { error } = await supabase
          .from('campaign_policies')
          .update({ enabled: !policy.enabled })
          .eq('id', policy.id);
        if (error) throw new Error(error.message);
        toast.success(policy.enabled ? 'Autopilot paused.' : 'Autopilot on.');
      }
      await loadPolicy();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update Autopilot');
    } finally {
      setBusy(false);
    }
  }

  async function saveField(patch: Partial<CampaignPolicy>) {
    if (!policy) return;
    setBusy(true);
    try {
      const { error } = await supabase.from('campaign_policies').update(patch).eq('id', policy.id);
      if (error) throw new Error(error.message);
      setPolicy({ ...policy, ...patch });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
      await loadPolicy();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return null;

  // Free tier: locked upsell.
  if (!paid) {
    return (
      <div className="autopilot-panel locked">
        <div className="autopilot-head">
          <span className="autopilot-title">Campaign Autopilot</span>
          <span className="badge">Paid feature</span>
        </div>
        <p className="autopilot-blurb">
          Let OutreachOS source new companies, research, draft, and send within your guardrails, holding
          low-confidence drafts for your review. Available on paid plans.
        </p>
        <Link to="/settings" className="btn-primary small">Upgrade to enable</Link>
      </div>
    );
  }

  const enabled = !!policy?.enabled;
  const p = policy;
  const sentToday = p?.counter && p.counter.date === new Date().toISOString().slice(0, 10) ? p.counter.sent : 0;

  return (
    <div className={`autopilot-panel${enabled ? ' on' : ''}`}>
      <div className="autopilot-head">
        <span className="autopilot-title">Campaign Autopilot</span>
        <span className={`status-pill${enabled ? ' is-success' : ''}`}>{enabled ? 'On' : 'Off'}</span>
        <div className="autopilot-head-actions">
          {policy && (
            <button type="button" className="link-button" onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide settings' : 'Settings'}
            </button>
          )}
          <button type="button" className="btn-primary small" disabled={busy} onClick={toggleEnabled}>
            {busy ? '…' : enabled ? 'Pause' : 'Turn on'}
          </button>
        </div>
      </div>

      {enabled && p && (
        <div className="autopilot-status">
          {p.auto_send ? (
            <span>Auto-sending up to <strong>{p.daily_send_cap}/day</strong> · <strong>{sentToday}</strong> sent today</span>
          ) : (
            <span>Staging for approval (auto-send off)</span>
          )}
          <span className="autopilot-dot">·</span>
          <span><strong>{counts.queued}</strong> queued</span>
          <span className="autopilot-dot">·</span>
          <span><strong>{counts.ready}</strong> ready</span>
          <span className="autopilot-dot">·</span>
          <span><strong>{counts.review}</strong> to review</span>
          {p.last_sourced_at && (
            <>
              <span className="autopilot-dot">·</span>
              <span>sourced {relativeTime(p.last_sourced_at)}</span>
            </>
          )}
        </div>
      )}

      {open && p && (
        <div className="autopilot-settings">
          <label className="autopilot-row toggle">
            <input
              type="checkbox"
              checked={p.auto_send}
              disabled={busy}
              onChange={(e) => saveField({ auto_send: e.target.checked })}
            />
            <span>
              <strong>Auto-send.</strong> When on, gate-passing drafts send automatically. When off, they wait
              as "Ready" for your one-click approval.
            </span>
          </label>

          <div className="autopilot-grid">
            <label className="autopilot-field">
              <span>Daily send cap</span>
              <input
                type="number"
                min={1}
                max={100}
                value={p.daily_send_cap}
                disabled={busy}
                onChange={(e) => saveField({ daily_send_cap: clampNum(e.target.value, 1, 100, 10) })}
              />
            </label>
            <label className="autopilot-field">
              <span>New companies / cycle</span>
              <input
                type="number"
                min={1}
                max={25}
                value={p.targets_per_cycle}
                disabled={busy}
                onChange={(e) => saveField({ targets_per_cycle: clampNum(e.target.value, 1, 25, 5) })}
              />
            </label>
            <label className="autopilot-field">
              <span>Min confidence</span>
              <input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={p.min_confidence}
                disabled={busy}
                onChange={(e) => saveField({ min_confidence: clampNum(e.target.value, 0, 1, 0.6) })}
              />
            </label>
            <label className="autopilot-field">
              <span>Source every (hrs)</span>
              <input
                type="number"
                min={1}
                max={336}
                value={p.cycle_interval_hours}
                disabled={busy}
                onChange={(e) => saveField({ cycle_interval_hours: clampNum(e.target.value, 1, 336, 24) })}
              />
            </label>
            <label className="autopilot-field">
              <span>Send window start</span>
              <input
                type="number"
                min={0}
                max={23}
                value={p.send_window.start_hour}
                disabled={busy}
                onChange={(e) =>
                  saveField({ send_window: { ...p.send_window, start_hour: clampNum(e.target.value, 0, 23, 9) } })
                }
              />
            </label>
            <label className="autopilot-field">
              <span>Send window end</span>
              <input
                type="number"
                min={1}
                max={24}
                value={p.send_window.end_hour}
                disabled={busy}
                onChange={(e) =>
                  saveField({ send_window: { ...p.send_window, end_hour: clampNum(e.target.value, 1, 24, 17) } })
                }
              />
            </label>
          </div>
          <p className="autopilot-tz">
            Gate: a draft auto-sends only when the address is <strong>verified</strong> and contact confidence ≥
            the threshold. Send window is in <strong>{p.timezone}</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

function clampNum(v: string, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
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
