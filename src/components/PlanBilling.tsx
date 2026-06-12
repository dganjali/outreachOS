import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, Loader2, Zap } from 'lucide-react';
import { billing, type BillingMe } from '../lib/api';
import { PLANS, PLAN_ORDER, type PlanId } from '../../shared/plans';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const over = used >= limit;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn('font-medium tabular-nums', over ? 'text-destructive' : 'text-foreground')}>
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <Progress value={pct} className={cn('h-2', over && '[&>div]:bg-destructive')} />
    </div>
  );
}

export function PlanBilling() {
  const location = useLocation();
  const [data, setData] = useState<BillingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<PlanId | 'portal' | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await billing.me());
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Surface the Checkout redirect result (?billing=success|cancelled).
  useEffect(() => {
    const status = new URLSearchParams(location.search).get('billing');
    if (status === 'success') toast.success('Subscription active — your new limits are live.');
    if (status === 'cancelled') toast('Checkout cancelled — no charge made.');
  }, [location.search]);

  async function upgrade(plan: PlanId) {
    setBusy(plan);
    try {
      const { url } = await billing.checkout(plan);
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout.');
      setBusy(null);
    }
  }

  async function manageBilling() {
    setBusy('portal');
    try {
      const { url } = await billing.portal();
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open billing portal.');
      setBusy(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading plan…</p>;
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">Couldn’t load billing info. Refresh to try again.</p>;
  }

  const current = PLANS[data.plan];

  return (
    <div className="flex flex-col gap-6">
      {/* Current plan + usage */}
      <div className="rounded-lg border border-border bg-secondary/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{current.name}</span>
            {data.plan !== 'free' && <Badge variant="secondary" className="text-primary">Active</Badge>}
            {data.plan_status === 'past_due' && (
              <Badge variant="secondary" className="text-destructive">Payment due</Badge>
            )}
          </div>
          {data.has_billing_account && (
            <Button variant="outline" size="sm" onClick={manageBilling} disabled={busy === 'portal'}>
              {busy === 'portal' ? 'Opening…' : 'Manage billing'}
            </Button>
          )}
        </div>

        {data.plan_renews_at && (
          <p className="mt-1 text-xs text-muted-foreground">
            {data.plan_status === 'canceled' ? 'Access ends' : 'Renews'}{' '}
            {new Date(data.plan_renews_at).toLocaleDateString()}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-3">
          <UsageMeter
            label="Mission launches this month"
            used={data.usage.missions_this_month}
            limit={data.limits.missions_per_month}
          />
          <UsageMeter label="Agent runs today" used={data.usage.runs_today} limit={data.limits.agent_runs_per_day} />
        </div>
      </div>

      {/* Plan cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          const isCurrent = data.plan === id;
          return (
            <div
              key={id}
              className={cn(
                'flex flex-col rounded-lg border p-4',
                isCurrent ? 'border-primary/50 bg-primary/5' : 'border-border'
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">{plan.name}</span>
                {isCurrent && <Badge variant="secondary" className="text-primary">Current</Badge>}
              </div>
              <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
                ${plan.priceMonthly}
                <span className="text-sm font-normal text-muted-foreground">/mo</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{plan.blurb}</p>
              <ul className="mt-3 flex flex-1 flex-col gap-1.5">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                {isCurrent ? (
                  <Button variant="outline" size="sm" className="w-full" disabled>
                    Current plan
                  </Button>
                ) : plan.purchasable ? (
                  <Button
                    size="sm"
                    className="w-full btn-glow border-0 font-semibold text-primary-foreground"
                    onClick={() => upgrade(id)}
                    disabled={busy === id}
                  >
                    {busy === id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Zap className="h-4 w-4" /> Upgrade
                      </>
                    )}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="w-full" disabled>
                    Free
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
