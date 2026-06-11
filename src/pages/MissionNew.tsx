import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { useAuth } from '../context/AuthContext';
import type { MissionMode } from '../types';
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button type="submit" className="font-semibold" disabled={saving}>
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
