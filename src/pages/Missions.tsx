import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Download, Archive, RotateCcw, Target, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { exportPipelineCsv } from '../lib/exportPipeline';
import type { Mission } from '../types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<string, string> = {
  active: 'border-primary/30 bg-primary/10 text-primary',
  running: 'border-primary/30 bg-primary/10 text-primary',
  draft: 'border-border bg-secondary text-muted-foreground',
  completed: 'border-border bg-secondary text-muted-foreground',
  archived: 'border-border bg-secondary text-muted-foreground',
};

function truncate(str: string, max: number) {
  if (str.length <= max) return str;
  return str.slice(0, max).trim() + '…';
}

function countBy(rows: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const k = String(r[key] ?? '');
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

const MODE_LABEL: Record<string, string> = {
  sponsorship: 'Sponsorship',
  bd: 'BD',
  internship: 'Internship',
  recruiting: 'Recruiting',
  sales: 'Sales',
};

interface MissionWithCounts extends Mission {
  target_count: number;
  draft_count: number;
}

export function Missions() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [missions, setMissions] = useState<MissionWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      await exportPipelineCsv();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  async function load(uid: string, includeArchived: boolean) {
    setLoading(true);
    setError(null);
    try {
      let query = supabase
        .from('missions')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false });
      if (!includeArchived) query = query.is('archived_at', null);
      const { data: ms, error: qErr } = await query;
      if (qErr) throw qErr;
      const list = (ms ?? []) as Mission[];
      // Two batched queries instead of two per mission — the per-mission
      // fan-out was a major contributor to exhausting browser connections
      // (ERR_INSUFFICIENT_RESOURCES) on accounts with many missions.
      const ids = list.map((m) => m.id);
      let targetCounts = new Map<string, number>();
      let draftCounts = new Map<string, number>();
      if (ids.length > 0) {
        const [tRes, sRes] = await Promise.all([
          supabase.from('targets').select('id, mission_id').in('mission_id', ids),
          supabase.from('email_sequences').select('id, mission_id').in('mission_id', ids),
        ]);
        if (tRes.error) throw new Error(tRes.error.message);
        if (sRes.error) throw new Error(sRes.error.message);
        targetCounts = countBy(tRes.data ?? [], 'mission_id');
        draftCounts = countBy(sRes.data ?? [], 'mission_id');
      }
      setMissions(
        list.map((m) => ({
          ...m,
          target_count: targetCounts.get(m.id) ?? 0,
          draft_count: draftCounts.get(m.id) ?? 0,
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load missions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user?.id) return;
    load(user.id, showArchived);
  }, [user?.id, showArchived]);

  async function archive(e: React.MouseEvent, mission: MissionWithCounts) {
    e.preventDefault();
    e.stopPropagation();
    if (
      !(await confirm({
        title: `Archive "${mission.name}"?`,
        description: 'You can restore it from the archived view.',
        confirmText: 'Archive',
      }))
    )
      return;
    const { error: err } = await supabase.from('missions').update({ archived_at: new Date().toISOString() }).eq('id', mission.id);
    if (err) {
      toast.error(`Could not archive: ${err.message}`);
      return;
    }
    toast.success(`Archived "${mission.name}"`);
    if (user?.id) load(user.id, showArchived);
  }

  async function restore(e: React.MouseEvent, mission: MissionWithCounts) {
    e.preventDefault();
    e.stopPropagation();
    const { error: err } = await supabase.from('missions').update({ archived_at: null }).eq('id', mission.id);
    if (err) {
      toast.error(`Could not restore: ${err.message}`);
      return;
    }
    toast.success(`Restored "${mission.name}"`);
    if (user?.id) load(user.id, showArchived);
  }

  async function remove(e: React.MouseEvent, mission: MissionWithCounts) {
    e.preventDefault();
    e.stopPropagation();
    if (
      !(await confirm({
        title: `Permanently delete "${mission.name}"?`,
        description: 'This also deletes its targets, drafts, and replies, and cannot be undone.',
        confirmText: 'Delete',
        destructive: true,
      }))
    )
      return;
    const { error: delErr } = await supabase.from('missions').delete().eq('id', mission.id);
    if (delErr) {
      toast.error(`Could not delete: ${delErr.message}`);
      return;
    }
    toast.success(`Deleted "${mission.name}" and all its data`);
    if (user?.id) load(user.id, showArchived);
  }

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Missions</h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" disabled={exporting} onClick={handleExport}>
            <Download className="h-4 w-4" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
          <Button asChild size="sm" className="gap-1.5 font-semibold">
            <Link to="/missions/new">
              <Plus className="h-4 w-4" /> Create mission
            </Link>
          </Button>
        </div>
      </header>

      {error ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <span>{error}</span>
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => user?.id && load(user.id, showArchived)}
          >
            Retry
          </button>
        </div>
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      ) : missions.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Target className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">No missions yet</h3>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            A mission is one outreach campaign, a mode (sponsorship, BD, sales…), an offer, and an
            audience. Create one and the agents take it from there.
          </p>
          <Button asChild className="mt-2 gap-1.5 font-semibold">
            <Link to="/missions/new">
              <Plus className="h-4 w-4" /> Create your first mission
            </Link>
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {missions.map((m) => (
            <Link
              key={m.id}
              to={`/missions/${m.id}`}
              className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary/50 hover:bg-secondary/30"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-base font-semibold leading-tight text-foreground">{m.name}</h3>
                <Badge variant="secondary" className="shrink-0 font-normal">{MODE_LABEL[m.mode] ?? m.mode}</Badge>
              </div>
              <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground" title={m.goal}>
                {truncate(m.goal, 140)}
              </p>
              <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-2 text-xs text-muted-foreground">
                <span className="tabular-nums">{m.target_count} targets</span>
                <span className="tabular-nums">{m.draft_count} drafts</span>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize',
                    STATUS_TONE[m.status] ?? 'border-border bg-secondary text-muted-foreground'
                  )}
                >
                  {m.status}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  {m.archived_at ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground"
                      onClick={(e) => restore(e, m)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-foreground"
                      onClick={(e) => archive(e, m)}
                    >
                      <Archive className="h-3.5 w-3.5" /> Archive
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-destructive"
                    onClick={(e) => remove(e, m)}
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
