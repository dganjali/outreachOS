import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { billing } from '../lib/api';
import type { CampaignPolicy } from '../types';
import type { PlanId } from '../../shared/plans';

// First-write shape. Everything except enabled/auto_send/daily_send_cap is a
// sensible default the user never sees (the cron also normalizes missing fields,
// see withPolicyDefaults in api/_lib/autopilot.ts).
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
  const [plan, setPlan] = useState<PlanId | null>(null);
  const [policy, setPolicy] = useState<CampaignPolicy | null>(null);
  const [counts, setCounts] = useState<Counts>({ queued: 0, ready: 0, review: 0 });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [capDraft, setCapDraft] = useState('10');

  const loadPolicy = useCallback(async () => {
    const { data } = await supabase.from('campaign_policies').select('*').eq('mission_id', missionId).maybeSingle();
    const pol = (data as CampaignPolicy | null) ?? null;
    setPolicy(pol);
    if (pol) setCapDraft(String(pol.daily_send_cap));
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
    setBusy(true);
    try {
      if (!policy) {
        await supabase.from('campaign_policies').insert({ mission_id: missionId, enabled: true, ...DEFAULTS });
        toast.success('Autopilot on. It starts sourcing and drafting on its next cycle.');
      } else {
        const { error } = await supabase
          .from('campaign_policies')
          .update({ enabled: !policy.enabled })
          .eq('id', policy.id);
        if (error) throw new Error(error.message);
        toast.success(policy.enabled ? 'Autopilot off.' : 'Autopilot on.');
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

  // Free tier: a single quiet upsell, no controls.
  if (!paid) {
    return (
      <div className="autopilot-panel">
        <div className="autopilot-head">
          <span className="autopilot-title">Campaign Autopilot</span>
          <span className="badge">Paid</span>
        </div>
        <p className="autopilot-blurb">
          Let OutreachOS find new companies for this mission, research them, and draft outreach on its own,
          holding low-confidence drafts for your review. Available on paid plans.
        </p>
        <Link to="/settings" className="btn-primary small">Upgrade to enable</Link>
      </div>
    );
  }

  const enabled = !!policy?.enabled;
  const p = policy;
  const sentToday = p?.counter && p.counter.date === new Date().toISOString().slice(0, 10) ? p.counter.sent : 0;

  const statusFrags: string[] = [];
  if (p) {
    if (counts.ready) statusFrags.push(`${counts.ready} to approve`);
    if (counts.queued) statusFrags.push(`${counts.queued} scheduled`);
    if (counts.review) statusFrags.push(`${counts.review} to review`);
    if (sentToday) statusFrags.push(`${sentToday} sent today`);
  }
  const status = statusFrags.length ? statusFrags.join(' · ') : 'Working on the first batch…';
  // "Working" = enabled but nothing has happened yet, so we show a spinner; the
  // cadence line removes the "flying blind" feeling by stating when it last ran
  // and how often it checks.
  const working = enabled && !!p && statusFrags.length === 0 && !p.last_sourced_at;
  const cadence = p
    ? `${p.last_sourced_at ? `Last ran ${relativeTime(p.last_sourced_at)}` : 'First run on the next cycle'} · checks every ${p.cycle_interval_hours ?? 24}h`
    : '';

  return (
    <div className="autopilot-panel">
      <div className="autopilot-head">
        <span className="autopilot-title">Campaign Autopilot</span>
        {enabled && <span className="status-pill is-success">On</span>}
        <div className="autopilot-head-actions">
          <button type="button" className="btn-secondary small" disabled={busy} onClick={toggleEnabled}>
            {busy ? '…' : enabled ? 'Turn off' : 'Turn on'}
          </button>
        </div>
      </div>

      {!enabled && (
        <p className="autopilot-blurb">
          Finds new companies that fit this mission, researches them, and drafts outreach on its own. Turn it
          on and choose how hands-off you want to be.
        </p>
      )}

      {enabled && p && (
        <>
          <p className="autopilot-status">
            {working && <Loader2 size={13} className="pw-spin" aria-hidden />}
            <span>{status}</span>
          </p>
          {cadence && <p className="autopilot-cadence">{cadence}</p>}

          <div className="pw">
            <div className="pw-field-label">When a draft is ready</div>
            <div className="pw-cards">
              <button
                type="button"
                className={`pw-card ${!p.auto_send ? 'is-on' : ''}`}
                disabled={busy}
                onClick={() => saveField({ auto_send: false })}
                aria-pressed={!p.auto_send}
              >
                {!p.auto_send && <span className="pw-card-check"><Check size={12} /></span>}
                <span className="pw-card-title">Review first</span>
                <span className="pw-card-hint">Autopilot drafts and waits. You approve every send.</span>
              </button>
              <button
                type="button"
                className={`pw-card ${p.auto_send ? 'is-on' : ''}`}
                disabled={busy}
                onClick={() => saveField({ auto_send: true })}
                aria-pressed={p.auto_send}
              >
                {p.auto_send && <span className="pw-card-check"><Check size={12} /></span>}
                <span className="pw-card-title">Send automatically</span>
                <span className="pw-card-hint">Sends verified, high-confidence contacts. Holds the rest for review.</span>
              </button>
            </div>
          </div>

          {p.auto_send && (
            <label className="autopilot-limit">
              <span>Send at most</span>
              <input
                type="number"
                min={1}
                max={100}
                value={capDraft}
                disabled={busy}
                onChange={(e) => setCapDraft(e.target.value)}
                onBlur={() => saveField({ daily_send_cap: clampNum(capDraft, 1, 100, 10) })}
              />
              <span>emails per day</span>
            </label>
          )}

          <p className="autopilot-note">
            Autopilot only sends to verified addresses, during business hours, and finds a few new companies a
            day. Low-confidence drafts always wait for your review.
          </p>
        </>
      )}
    </div>
  );
}

function clampNum(v: string, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
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
