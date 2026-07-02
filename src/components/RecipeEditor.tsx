// RecipeEditor - the modular pipeline "IDE" surface. Renders a mission's recipe
// as an ordered set of stage cards the user can enable/disable and tune:
// sourcing -> verification -> research -> person sourcing -> sequencing -> send.
//
// The SAME editor backs both manual (Setup tab) and Autopilot (cockpit), so the
// two can't drift - editing the recipe changes what the next run does either way.
// Every change is a clamped stage patch applied server-side via applyRecipePatch.

import { useEffect, useState } from 'react';
import { autopilot, type RecipePatch } from '../lib/api';
import type { MissionRecipe } from '../types';
import { toast } from 'sonner';

const SENIORITY_HINT = 'e.g. vp, director, cxo';

export function RecipeEditor({
  missionId,
  recipe: provided,
  onSaved,
  compact,
}: {
  missionId: string;
  recipe?: MissionRecipe | null;
  onSaved?: (r: MissionRecipe) => void;
  compact?: boolean;
}) {
  const [recipe, setRecipe] = useState<MissionRecipe | null>(provided ?? null);
  const [loading, setLoading] = useState(!provided);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (provided) {
      setRecipe(provided);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await autopilot.getRecipe(missionId);
        if (!cancelled) setRecipe(data);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : 'Could not load the recipe');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [missionId, provided]);

  async function save(patch: RecipePatch, optimistic: MissionRecipe) {
    setRecipe(optimistic); // optimistic; reconcile from the server response
    setSaving(true);
    try {
      const { data } = await autopilot.saveRecipe(missionId, patch);
      setRecipe(data);
      onSaved?.(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the recipe');
      // Re-fetch to drop the failed optimistic state.
      try {
        const { data } = await autopilot.getRecipe(missionId);
        setRecipe(data);
      } catch {
        /* keep the optimistic value; a reload will reconcile */
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading || !recipe) {
    return <div className="recipe-editor recipe-editor--loading">Loading recipe…</div>;
  }
  const r = recipe;

  // Per-stage patch helpers keep the optimistic clone + the wire patch in sync.
  const patchSourcing = (p: Partial<MissionRecipe['sourcing']>) =>
    save({ sourcing: p }, { ...r, sourcing: { ...r.sourcing, ...p } });
  const patchVerification = (p: Partial<MissionRecipe['verification']>) =>
    save({ verification: p }, { ...r, verification: { ...r.verification, ...p } });
  const patchResearch = (p: Partial<MissionRecipe['research']>) =>
    save({ research: p }, { ...r, research: { ...r.research, ...p } });
  const patchPerson = (p: Partial<MissionRecipe['person_sourcing']>) =>
    save({ person_sourcing: p }, { ...r, person_sourcing: { ...r.person_sourcing, ...p } });
  const patchSequencing = (p: Partial<MissionRecipe['sequencing']>) =>
    save({ sequencing: p }, { ...r, sequencing: { ...r.sequencing, ...p } });

  const people = r.sourcing.find_mode === 'people';

  return (
    <div className={`recipe-editor${compact ? ' recipe-editor--compact' : ''}`} aria-busy={saving}>
      <StageCard
        n={1}
        title="Sourcing"
        subtitle={people ? 'Who to find (people directly)' : 'Which companies to find'}
        enabled={r.sourcing.enabled}
        onToggle={(enabled) => patchSourcing({ enabled })}
      >
        <NumberField
          label={people ? 'People to discover per run' : 'Companies to discover per run'}
          value={r.sourcing.count}
          min={1}
          max={25}
          onCommit={(count) => patchSourcing({ count })}
        />
        <NumberField
          label="How many to actually pursue"
          value={r.sourcing.top_n}
          min={1}
          max={15}
          onCommit={(top_n) => patchSourcing({ top_n })}
        />
        <ListField
          label="Sector bias (optional)"
          hint="e.g. fintech, developer tools"
          value={r.sourcing.sectors}
          onCommit={(sectors) => patchSourcing({ sectors })}
        />
        <p className="recipe-note">Sourcing changes apply to the next run, not companies already found.</p>
      </StageCard>

      <StageCard
        n={2}
        title="Verification"
        subtitle="Reachable + a good fit"
        enabled={r.verification.enabled}
        onToggle={(enabled) => patchVerification({ enabled })}
      >
        <ToggleField
          label="Verify email addresses"
          value={r.verification.email_verify}
          onChange={(email_verify) => patchVerification({ email_verify })}
        />
        <ToggleField
          label="Screen each contact for fit"
          value={r.verification.contact_verify}
          onChange={(contact_verify) => patchVerification({ contact_verify })}
        />
        <NumberField
          label="Auto-send confidence floor (0-1)"
          value={r.verification.min_confidence}
          min={0}
          max={1}
          step={0.05}
          onCommit={(min_confidence) => patchVerification({ min_confidence })}
        />
      </StageCard>

      <StageCard
        n={3}
        title="Research"
        subtitle="Proof to personalize with"
        enabled={r.research.enabled}
        onToggle={(enabled) => patchResearch({ enabled })}
      >
        <ToggleField
          label="Gather evidence (cited proof per company)"
          value={r.research.evidence}
          onChange={(evidence) => patchResearch({ evidence })}
        />
        <ToggleField
          label="Enrich company details"
          value={r.research.company_enrich}
          onChange={(company_enrich) => patchResearch({ company_enrich })}
        />
      </StageCard>

      <StageCard
        n={4}
        title="Person sourcing"
        subtitle="Which people, and how many"
        enabled={r.person_sourcing.enabled}
        onToggle={(enabled) => patchPerson({ enabled })}
      >
        <NumberField
          label="Contacts per company"
          value={r.person_sourcing.contacts_per_company}
          min={1}
          max={5}
          disabled={people}
          hint={people ? 'People mode targets one person each.' : undefined}
          onCommit={(contacts_per_company) => patchPerson({ contacts_per_company })}
        />
        <ListField
          label="Teams / functions to prioritize"
          hint="e.g. sales, engineering"
          value={r.person_sourcing.functions}
          onCommit={(functions) => patchPerson({ functions })}
        />
        <ListField
          label="Seniority to prioritize"
          hint={SENIORITY_HINT}
          value={r.person_sourcing.seniority}
          onCommit={(seniority) => patchPerson({ seniority: seniority as MissionRecipe['person_sourcing']['seniority'] })}
        />
      </StageCard>

      <StageCard
        n={5}
        title="Sequencing"
        subtitle="How the outreach reads"
        enabled={r.sequencing.enabled}
        onToggle={(enabled) => patchSequencing({ enabled })}
      >
        <NumberField
          label="Touches (initial + follow-ups)"
          value={r.sequencing.touches}
          min={1}
          max={5}
          onCommit={(touches) => patchSequencing({ touches })}
        />
      </StageCard>

      <p className="recipe-editor-foot">
        Sending cadence + guardrails live in the schedule controls above. Ask the steering chat to change any of these in
        plain English, too.
      </p>
    </div>
  );
}

// --- stage card + field primitives ---------------------------------------

function StageCard({
  n,
  title,
  subtitle,
  enabled,
  onToggle,
  children,
}: {
  n: number;
  title: string;
  subtitle: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`recipe-stage${enabled ? '' : ' is-off'}`}>
      <header className="recipe-stage-head">
        <span className="recipe-stage-n">{n}</span>
        <span className="recipe-stage-titles">
          <span className="recipe-stage-title">{title}</span>
          <span className="recipe-stage-sub">{subtitle}</span>
        </span>
        <label className="recipe-stage-switch">
          <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
          <span>{enabled ? 'On' : 'Off'}</span>
        </label>
      </header>
      {enabled && <div className="recipe-stage-body">{children}</div>}
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  disabled,
  hint,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  hint?: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.max(min, Math.min(max, n));
    if (clamped !== value) onCommit(clamped);
    else setDraft(String(value));
  };
  return (
    <label className="recipe-field">
      <span className="recipe-field-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {hint && <span className="recipe-field-hint">{hint}</span>}
    </label>
  );
}

function ListField({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: string[];
  onCommit: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(', '));
  useEffect(() => setDraft(value.join(', ')), [value]);
  const commit = () => {
    const next = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (next.join('\n') !== value.join('\n')) onCommit(next);
    else setDraft(value.join(', '));
  };
  return (
    <label className="recipe-field">
      <span className="recipe-field-label">{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={hint}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {hint && <span className="recipe-field-hint">{hint}</span>}
    </label>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="recipe-toggle">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
