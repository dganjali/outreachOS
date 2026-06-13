import { useState } from 'react';
import type { ProfileSnapshot } from '../../lib/profileSnapshot';
import type { Profile, ProfileAsset } from '../../types';
import type { CoachField } from '../../lib/api';
import { AssetUploader } from '../../components/me/AssetUploader';

type PanelKey = 'identity' | 'pitch' | 'proof' | 'assets';

function countFilled(values: string[]): { filled: number; total: number } {
  return {
    filled: values.filter((v) => v.trim().length > 0).length,
    total: values.length,
  };
}

export function scorePanel(form: ProfileSnapshot, key: PanelKey): { filled: number; total: number } {
  switch (key) {
    case 'identity':
      return countFilled([form.name, form.role, form.organization]);
    case 'pitch':
      return countFilled([form.bio]);
    case 'proof':
      return countFilled([
        form.proof_points,
        form.achievements,
        form.metrics,
        form.portfolio_links.length ? 'x' : '',
      ]);
    case 'assets':
      return countFilled([form.resume_url, form.linkedin_url, form.website]);
  }
}

export function totalScore(form: ProfileSnapshot) {
  const panels: PanelKey[] = ['identity', 'pitch', 'proof', 'assets'];
  return panels.reduce(
    (acc, k) => {
      const s = scorePanel(form, k);
      return { filled: acc.filled + s.filled, total: acc.total + s.total };
    },
    { filled: 0, total: 0 }
  );
}

interface WorkshopProps {
  form: ProfileSnapshot;
  setForm: React.Dispatch<React.SetStateAction<ProfileSnapshot>>;
  profile: Profile | null;
  saving: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  onCoach: (field: CoachField, current: string) => void;
  assetReloadKey: number;
  onAssetUploaded: (asset: ProfileAsset) => void;
  onAssetError: (msg: string) => void;
}

export function Workshop({
  form,
  setForm,
  profile,
  saving,
  error,
  onSubmit,
  onCoach,
  assetReloadKey,
  onAssetUploaded,
  onAssetError,
}: WorkshopProps) {
  const [open, setOpen] = useState<Record<PanelKey, boolean>>({
    identity: true,
    pitch: true,
    proof: false,
    assets: false,
  });

  function set<K extends keyof ProfileSnapshot>(key: K, value: ProfileSnapshot[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggle(key: PanelKey) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }

  return (
    <form onSubmit={onSubmit} className="me-workshop">
      <Panel
        title="Identity"
        hint="Who you are and where you sit."
        open={open.identity}
        score={scorePanel(form, 'identity')}
        onToggle={() => toggle('identity')}
      >
        <div className="me-grid">
          <Field label="Name">
            <input
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="Role / title">
            <input
              type="text"
              value={form.role}
              onChange={(e) => set('role', e.target.value)}
            />
          </Field>
          <Field label="Organization">
            <input
              type="text"
              value={form.organization}
              onChange={(e) => set('organization', e.target.value)}
            />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Pitch"
        hint="One short paragraph: what you do, who you do it for, why it matters."
        open={open.pitch}
        score={scorePanel(form, 'pitch')}
        onToggle={() => toggle('pitch')}
      >
        <Field label="Bio" coach={{ field: 'bio', value: form.bio, onCoach }}>
          <textarea
            rows={4}
            placeholder="e.g. I build agent-assisted outreach tooling for founders who hate cold-email tool-hopping."
            value={form.bio}
            onChange={(e) => set('bio', e.target.value)}
          />
        </Field>
      </Panel>

      <Panel
        title="Proof"
        hint="Specifics here become anchor points the agent can cite. Numbers > adjectives."
        open={open.proof}
        score={scorePanel(form, 'proof')}
        onToggle={() => toggle('proof')}
      >
        <Field
          label="Proof points"
          coach={{ field: 'proof_points', value: form.proof_points, onCoach }}
        >
          <textarea
            rows={3}
            placeholder="e.g. ran a 1,400-person developer conference, backed by Vercel/Notion"
            value={form.proof_points}
            onChange={(e) => set('proof_points', e.target.value)}
          />
        </Field>
        <Field
          label="Achievements"
          coach={{ field: 'achievements', value: form.achievements, onCoach }}
        >
          <textarea
            rows={3}
            value={form.achievements}
            onChange={(e) => set('achievements', e.target.value)}
          />
        </Field>
        <Field label="Metrics" coach={{ field: 'metrics', value: form.metrics, onCoach }}>
          <textarea
            rows={3}
            placeholder="e.g. 2.3k weekly DAUs, 41% MoM growth, $120k ARR"
            value={form.metrics}
            onChange={(e) => set('metrics', e.target.value)}
          />
        </Field>
        <Field label="Portfolio links (one per line)">
          <textarea
            rows={3}
            value={form.portfolio_links.join('\n')}
            onChange={(e) =>
              set(
                'portfolio_links',
                e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
              )
            }
          />
        </Field>
      </Panel>

      <Panel
        title="Links & files"
        hint="Links and uploads the agent can pull from. Upload a resume to import details into the fields above."
        open={open.assets}
        score={scorePanel(form, 'assets')}
        onToggle={() => toggle('assets')}
      >
        <div className="me-grid">
          <Field label="LinkedIn">
            <input
              type="url"
              value={form.linkedin_url}
              onChange={(e) => set('linkedin_url', e.target.value)}
            />
          </Field>
          <Field label="Website">
            <input
              type="url"
              value={form.website}
              onChange={(e) => set('website', e.target.value)}
            />
          </Field>
          <Field label="Resume URL (or upload below)">
            <input
              type="url"
              value={form.resume_url}
              onChange={(e) => set('resume_url', e.target.value)}
            />
          </Field>
        </div>

        {profile?.user_id && (
          <AssetUploader
            userId={profile.user_id}
            reloadKey={assetReloadKey}
            onUploaded={onAssetUploaded}
            onError={onAssetError}
          />
        )}
      </Panel>

      {error && (
        <p role="alert" className="banner-error">
          {error}
        </p>
      )}

      <div className="me-actions">
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </form>
  );
}

function Panel({
  title,
  hint,
  open,
  score,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  open: boolean;
  score: { filled: number; total: number };
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const status: 'empty' | 'partial' | 'full' =
    score.filled === 0 ? 'empty' : score.filled < score.total ? 'partial' : 'full';
  return (
    <section className={`me-panel me-panel-${status}`} data-open={open}>
      <button
        type="button"
        className="me-panel-head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <div className="me-panel-headline">
          <h2>{title}</h2>
          <p>{hint}</p>
        </div>
        <div className="me-panel-meta">
          <span className={`me-panel-pip me-panel-pip-${status}`}>
            {score.filled}/{score.total}
          </span>
          <span className="me-panel-chev" aria-hidden>
            {open ? '–' : '+'}
          </span>
        </div>
      </button>
      {open && <div className="me-panel-body">{children}</div>}
    </section>
  );
}

function Field({
  label,
  coach,
  children,
}: {
  label: string;
  coach?: { field: CoachField; value: string; onCoach: (f: CoachField, v: string) => void };
  children: React.ReactNode;
}) {
  return (
    <label className="me-field">
      <span className="me-field-label-row">
        <span className="me-field-label">{label}</span>
        {coach && (
          <button
            type="button"
            className="me-field-coach"
            onClick={(e) => {
              e.preventDefault();
              coach.onCoach(coach.field, coach.value);
            }}
            title="Ask the coach to suggest rewrites"
          >
            Coach
          </button>
        )}
      </span>
      {children}
    </label>
  );
}
