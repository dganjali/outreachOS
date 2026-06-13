import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Mic2, Plus } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { MissionMode, Persona } from '../types';
import { listPersonas, createPersona } from '../lib/personas';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const MODES: Array<{ value: MissionMode; label: string; hint: string }> = [
  { value: 'sponsorship', label: 'Sponsorship', hint: 'Get companies to sponsor an event/community' },
  { value: 'bd', label: 'BD / Partnerships', hint: 'Land integration or partnership deals' },
  { value: 'internship', label: 'Internship / Job', hint: 'Land a role at a target org' },
  { value: 'recruiting', label: 'Recruiting', hint: 'Source candidates for an open role' },
  { value: 'sales', label: 'Cold Sales', hint: 'Sell a product or service' },
];

export function MissionNew() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const isWelcome = params.get('welcome') === '1';
  const [name, setName] = useState('');
  const [mode, setMode] = useState<MissionMode>('sponsorship');
  const [whatSending, setWhatSending] = useState('');
  const [whoAndWhy, setWhoAndWhy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Persona gate — a mission must draft as a reusable voice (persona).
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [newPersonaName, setNewPersonaName] = useState('');
  const [creatingPersona, setCreatingPersona] = useState(false);

  useEffect(() => {
    if (!user) return;
    listPersonas(user.id)
      .then((ps) => {
        setPersonas(ps);
        // Default to the first persona so the common case is one click.
        setPersonaId((cur) => cur ?? ps[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load personas'));
  }, [user]);

  async function handleCreatePersona() {
    if (!user || !newPersonaName.trim()) return;
    setCreatingPersona(true);
    setError(null);
    try {
      const p = await createPersona(user.id, { name: newPersonaName, mode, offer: whatSending, audience: whoAndWhy });
      setPersonas((prev) => [...prev, p]);
      setPersonaId(p.id);
      setNewPersonaName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'persona create failed');
    } finally {
      setCreatingPersona(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!personaId) {
      setError('Pick or create a persona — every mission drafts as a reusable voice.');
      return;
    }
    setSaving(true);
    const { data, error: err } = await supabase
      .from('missions')
      .insert({
        user_id: user!.id,
        name: name.trim(),
        mode,
        goal: whatSending.trim(),
        target_description: whoAndWhy.trim(),
        status: 'active',
        persona_id: personaId,
      })
      .select('id')
      .single();
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    navigate(data ? `/missions/${data.id}/run` : '/missions', { replace: true });
  }

  return (
    <div className="mx-auto max-w-2xl animate-fade-in">
      <Link
        to="/missions"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Missions
      </Link>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
        {isWelcome ? 'Create your first mission' : 'Create mission'}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {isWelcome
          ? "You're all set. A mission tells the agent who you're trying to reach and what you're offering, fill it in and we'll find targets, contacts, and draft emails for you."
          : "Pick a mode, define what you're sending, and describe who you want to reach. The agent will do the rest."}
      </p>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="mission-name">Mission name</Label>
          <Input
            id="mission-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q1 sponsorship outreach"
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Mode</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {MODES.map((m) => {
              const selected = mode === m.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  className={cn(
                    'relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                    selected
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-card hover:border-border/80 hover:bg-secondary/40'
                  )}
                  onClick={() => setMode(m.value)}
                  aria-pressed={selected}
                >
                  {selected && (
                    <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="h-3 w-3" />
                    </span>
                  )}
                  <span className="text-sm font-semibold text-foreground">{m.label}</span>
                  <span className="text-xs leading-snug text-muted-foreground">{m.hint}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="mission-what">What you're sending / your offer</Label>
          <Textarea
            id="mission-what"
            value={whatSending}
            onChange={(e) => setWhatSending(e.target.value)}
            rows={3}
            placeholder="Be specific. e.g. 'Sponsorship tiers $5k–25k for a 1,400-person developer conference (60% senior engineers).'"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mission-who">Who you want to reach (the why)</Label>
          <Textarea
            id="mission-who"
            value={whoAndWhy}
            onChange={(e) => setWhoAndWhy(e.target.value)}
            rows={3}
            placeholder="e.g. 'Dev tools companies with active student programs and recent hackathon sponsorships in 2025.'"
            required
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label className="flex items-center gap-1.5">
            <Mic2 className="h-4 w-4" /> Voice (persona)
          </Label>
          <p className="text-xs leading-snug text-muted-foreground">
            Every mission drafts as a reusable voice. Pick one or create a new persona — refine it any time in{' '}
            <Link to="/me" className="underline hover:text-foreground">
              Me → Voice
            </Link>
            .
          </p>
          {personas.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {personas.map((p) => {
                const selected = personaId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={cn(
                      'relative flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                      selected
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-card hover:border-border/80 hover:bg-secondary/40'
                    )}
                    onClick={() => setPersonaId(p.id)}
                    aria-pressed={selected}
                  >
                    {selected && (
                      <span className="absolute right-2.5 top-2.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                    <span className="text-sm font-semibold text-foreground">{p.name}</span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {p.onboarding_completed_at ? 'Calibrated' : 'Not yet calibrated'}
                      {p.mode ? ` · ${p.mode}` : ''}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <Input
                type="text"
                value={newPersonaName}
                onChange={(e) => setNewPersonaName(e.target.value)}
                placeholder={personas.length ? 'New persona name (e.g. Recruiting voice)' : 'Name your first voice (e.g. Sponsorship voice)'}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleCreatePersona}
              disabled={creatingPersona || !newPersonaName.trim()}
              className="shrink-0"
            >
              <Plus className="mr-1 h-4 w-4" /> {creatingPersona ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" className="font-semibold" disabled={saving || !personaId}>
            {saving ? 'Creating…' : 'Create mission'}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/missions">Cancel</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
