import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Download, Archive, RotateCcw, Target, Trash2, Search, X, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { exportPipelineCsv } from '../lib/exportPipeline';
import type { Mission } from '../types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, timeAgo } from '@/lib/utils';

// Status filter buckets shown as chips. 'active' folds in the 'running' status.
const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft', label: 'Draft' },
  { id: 'completed', label: 'Done' },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]['id'];

function matchesStatus(status: string, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return status === 'active' || status === 'running';
  return status === filter;
}

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

// Count DISTINCT values of `distinctKey` within each `groupKey`. Used for draft
// counts: a "draft" is one-per-contact, so counting distinct contacts (not raw
// email_sequences rows) keeps this card in agreement with the mission header and
// dashboard even if a contact ever ends up with more than one sequence row.
function countDistinctBy(
  rows: Array<Record<string, unknown>>,
  groupKey: string,
  distinctKey: string
): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const g = String(r[groupKey] ?? '');
    const d = String(r[distinctKey] ?? '');
    if (!seen.has(g)) seen.set(g, new Set());
    seen.get(g)!.add(d);
  }
  const map = new Map<string, number>();
  for (const [g, set] of seen) map.set(g, set.size);
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const searchRef = useRef<HTMLInputElement>(null);

  // GitHub-style "/" to focus search, "Esc" to clear it - but never hijack the
  // key while the user is already typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && el === searchRef.current) {
        setSearch('');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const visibleMissions = useMemo(() => {
    const q = search.trim().toLowerCase();
    return missions.filter(
      (m) =>
        matchesStatus(m.status, statusFilter) &&
        (q === '' ||
          m.name.toLowerCase().includes(q) ||
          (m.goal ?? '').toLowerCase().includes(q) ||
          (MODE_LABEL[m.mode] ?? m.mode).toLowerCase().includes(q)),
    );
  }, [missions, search, statusFilter]);

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
      // Two batched queries instead of two per mission - the per-mission
      // fan-out was a major contributor to exhausting browser connections
      // (ERR_INSUFFICIENT_RESOURCES) on accounts with many missions.
      const ids = list.map((m) => m.id);
      let targetCounts = new Map<string, number>();
      let draftCounts = new Map<string, number>();
      if (ids.length > 0) {
        const [tRes, sRes] = await Promise.all([
          supabase.from('targets').select('id, mission_id').in('mission_id', ids),
          supabase.from('email_sequences').select('mission_id, contact_id').in('mission_id', ids),
        ]);
        if (tRes.error) throw new Error(tRes.error.message);
        if (sRes.error) throw new Error(sRes.error.message);
        targetCounts = countBy(tRes.data ?? [], 'mission_id');
        draftCounts = countDistinctBy(sRes.data ?? [], 'mission_id', 'contact_id');
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

  // Optimistically drop the card from the list, then run the mutation. On
  // failure we restore the snapshot and surface a toast - no full-page refetch
  // flash on the happy path.
  function optimisticRemove(id: string): MissionWithCounts[] {
    const snapshot = missions;
    setMissions((prev) => prev.filter((m) => m.id !== id));
    return snapshot;
  }

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
    const snapshot = optimisticRemove(mission.id);
    const { error: err } = await supabase.from('missions').update({ archived_at: new Date().toISOString() }).eq('id', mission.id);
    if (err) {
      setMissions(snapshot);
      toast.error(`Could not archive: ${err.message}`);
      return;
    }
    toast.success(`Archived "${mission.name}"`);
  }

  async function restore(e: React.MouseEvent, mission: MissionWithCounts) {
    e.preventDefault();
    e.stopPropagation();
    const snapshot = optimisticRemove(mission.id);
    const { error: err } = await supabase.from('missions').update({ archived_at: null }).eq('id', mission.id);
    if (err) {
      setMissions(snapshot);
      toast.error(`Could not restore: ${err.message}`);
      return;
    }
    toast.success(`Restored "${mission.name}"`);
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
    const snapshot = optimisticRemove(mission.id);
    const { error: delErr } = await supabase.from('missions').delete().eq('id', mission.id);
    if (delErr) {
      setMissions(snapshot);
      toast.error(`Could not delete: ${delErr.message}`);
      return;
    }
    toast.success(`Deleted "${mission.name}" and all its data`);
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

      {!loading && !error && missions.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search missions…  (press / )"
              aria-label="Search missions"
              className="h-9 pl-9 pr-8"
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setSearch('');
                  searchRef.current?.focus();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card/50 p-0.5">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  statusFilter === f.id
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {visibleMissions.length} of {missions.length}
          </span>
        </div>
      )}

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
      ) : visibleMissions.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Search className="h-6 w-6" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">No matches</h3>
          <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
            No missions match {search ? <>“{search}”</> : 'this filter'}. Try a different search or
            status.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-1"
            onClick={() => {
              setSearch('');
              setStatusFilter('all');
            }}
          >
            Clear filters
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleMissions.map((m) => (
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
                {m.created_at && (
                  <span
                    className="inline-flex items-center gap-1 tabular-nums"
                    title={new Date(m.created_at).toLocaleString()}
                  >
                    <Clock className="h-3 w-3" />
                    {timeAgo(m.created_at)}
                  </span>
                )}
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
