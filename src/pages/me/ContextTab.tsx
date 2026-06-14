// The Context tab - what the agent knows about *you*, shared across every voice.
//
// One source of truth: person-level context facts (the same facts your Voices
// read when drafting). Add a fact here and any voice can cite it; add one in a
// voice and it shows up here. No web-scraped guesses - everything is entered or
// confirmed by you. Identity + links round it out.

import { useRef, useState } from 'react';
import { Plus, X, Sparkles, Loader2, FileText, UserSearch } from 'lucide-react';
import type { ProfileSnapshot } from '../../lib/profileSnapshot';
import type { Profile, ContextFact } from '../../types';
import { agents } from '../../lib/api';
import { uploadAsset, MAX_ASSET_BYTES } from '../../lib/profileAssets';

type PanelKey = 'identity' | 'facts' | 'links';

function countFilled(values: string[]): { filled: number; total: number } {
  return { filled: values.filter((v) => v.trim().length > 0).length, total: values.length };
}

export function scorePanel(
  form: ProfileSnapshot,
  factsCount: number,
  key: PanelKey
): { filled: number; total: number } {
  switch (key) {
    case 'identity':
      return countFilled([form.name, form.role, form.organization]);
    case 'facts':
      return { filled: factsCount > 0 ? 1 : 0, total: 1 };
    case 'links':
      return countFilled([form.linkedin_url, form.website]);
  }
}

export function totalScore(form: ProfileSnapshot, factsCount: number) {
  const panels: PanelKey[] = ['identity', 'facts', 'links'];
  return panels.reduce(
    (acc, k) => {
      const s = scorePanel(form, factsCount, k);
      return { filled: acc.filled + s.filled, total: acc.total + s.total };
    },
    { filled: 0, total: 0 }
  );
}

interface ContextTabProps {
  form: ProfileSnapshot;
  setForm: React.Dispatch<React.SetStateAction<ProfileSnapshot>>;
  profile: Profile | null;
  userId: string;
  saving: boolean;
  error: string | null;
  onSubmit: (e: React.FormEvent) => void;
  facts: ContextFact[];
  factsLoading: boolean;
  onAddFact: (claim: string) => Promise<void> | void;
  onRemoveFact: (id: string) => Promise<void> | void;
  /** Called after Smart-fill extracts facts (which persist server-side) so the
   *  parent can reload the canonical list. */
  onFactsChanged: () => void;
  /** Persist the form, run LinkedIn enrichment, refresh profile + facts. Throws
   *  on failure so the button can surface the error inline. */
  onAutofill: () => Promise<void>;
}

export function ContextTab({
  form,
  setForm,
  profile,
  userId,
  saving,
  error,
  onSubmit,
  facts,
  factsLoading,
  onAddFact,
  onRemoveFact,
  onFactsChanged,
  onAutofill,
}: ContextTabProps) {
  const [open, setOpen] = useState<Record<PanelKey, boolean>>({
    identity: true,
    facts: true,
    links: false,
  });
  const [autofilling, setAutofilling] = useState(false);
  const [autofillError, setAutofillError] = useState<string | null>(null);

  function set<K extends keyof ProfileSnapshot>(key: K, value: ProfileSnapshot[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function toggle(key: PanelKey) {
    setOpen((o) => ({ ...o, [key]: !o[key] }));
  }

  const hasLinkedin = /linkedin\.com/i.test(form.linkedin_url);

  async function autofill() {
    setAutofilling(true);
    setAutofillError(null);
    try {
      await onAutofill();
    } catch (e) {
      setAutofillError(e instanceof Error ? e.message : 'Autofill failed - try again.');
    } finally {
      setAutofilling(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="me-workshop">
      <Panel
        title="Identity"
        hint="Who you are and where you sit."
        open={open.identity}
        score={scorePanel(form, facts.length, 'identity')}
        onToggle={() => toggle('identity')}
      >
        <div className="me-grid">
          <Field label="Name">
            <input type="text" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Role / title">
            <input type="text" value={form.role} onChange={(e) => set('role', e.target.value)} />
          </Field>
          <Field label="Organization">
            <input type="text" value={form.organization} onChange={(e) => set('organization', e.target.value)} />
          </Field>
        </div>
      </Panel>

      <Panel
        title="Facts"
        hint="The concrete things the agent can cite - what you've built, real numbers, credentials. Shared across every voice; facts you add in a voice show up here too."
        open={open.facts}
        score={scorePanel(form, facts.length, 'facts')}
        onToggle={() => toggle('facts')}
        pip={facts.length > 0 ? `${facts.length}` : undefined}
      >
        <FactsEditor
          userId={userId}
          facts={facts}
          loading={factsLoading}
          onAddFact={onAddFact}
          onRemoveFact={onRemoveFact}
          onFactsChanged={onFactsChanged}
        />
      </Panel>

      <Panel
        title="Links & files"
        hint="Links and files the agent can mine for facts. Grab from LinkedIn or drop a résumé - both add facts under Facts above."
        open={open.links}
        score={scorePanel(form, facts.length, 'links')}
        onToggle={() => toggle('links')}
      >
        <div className="me-grid">
          <Field label="LinkedIn">
            <input type="url" value={form.linkedin_url} onChange={(e) => set('linkedin_url', e.target.value)} placeholder="https://www.linkedin.com/in/…" />
          </Field>
          <Field label="Website">
            <input type="url" value={form.website} onChange={(e) => set('website', e.target.value)} placeholder="https://…" />
          </Field>
        </div>

        <div className="me-autofill">
          <button
            type="button"
            className="pw-btn-add"
            onClick={autofill}
            disabled={autofilling || !hasLinkedin}
            title={hasLinkedin ? undefined : 'Add your LinkedIn URL above first'}
          >
            {autofilling ? <Loader2 className="pw-spin" size={14} /> : <UserSearch size={14} />}
            {autofilling ? 'Reading your LinkedIn…' : 'Grab facts from LinkedIn'}
          </button>
          <p className="section-hint">
            Pulls public, sourceable facts from your LinkedIn and adds them to Facts above. Review and
            prune anything off - nothing is sent without your say-so.
          </p>
          {autofillError && <p className="pw-error">{autofillError}</p>}
        </div>

        <ResumeDropzone userId={userId} onFactsChanged={onFactsChanged} />
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
      {profile == null && <span className="sr-only">Sign in to save your context.</span>}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Facts editor - manual add + Smart fill (paste / upload → extract) + chip list
// ---------------------------------------------------------------------------
function FactsEditor({
  userId,
  facts,
  loading,
  onAddFact,
  onRemoveFact,
  onFactsChanged,
}: {
  userId: string;
  facts: ContextFact[];
  loading: boolean;
  onAddFact: (claim: string) => Promise<void> | void;
  onRemoveFact: (id: string) => Promise<void> | void;
  onFactsChanged: () => void;
}) {
  const [text, setText] = useState('');
  const [dumpText, setDumpText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [adding, setAdding] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function add() {
    const claim = text.trim();
    if (!claim) return;
    setAdding(true);
    try {
      await onAddFact(claim);
      setText('');
    } finally {
      setAdding(false);
    }
  }

  async function runExtract(opts: { text?: string; assetId?: string }) {
    setExtracting(true);
    setExtractError(null);
    try {
      await agents.extractContext({ text: opts.text, asset_id: opts.assetId });
      setDumpText('');
      onFactsChanged();
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Extraction failed - try again.');
    } finally {
      setExtracting(false);
    }
  }

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (file.size > MAX_ASSET_BYTES) {
      setExtractError(`File too large. Max 20MB; this file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }
    setExtracting(true);
    setExtractError(null);
    try {
      const asset = await uploadAsset({ userId, kind: 'context_dump', file });
      await runExtract({ assetId: asset.id });
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : 'Upload failed - try again.');
      setExtracting(false);
    }
  }

  return (
    <div className="me-facts">
      {/* Smart fill */}
      <div className="pw-smartfill">
        <div className="pw-smartfill-head">
          <span className="pw-smartfill-title">
            <Sparkles size={13} /> Smart fill
          </span>
        </div>
        <p className="pw-smartfill-hint">Paste your resume, bio, or any context - or drop a file - and we'll pull the facts out.</p>
        <textarea
          className="pw-input pw-textarea"
          rows={3}
          value={dumpText}
          onChange={(e) => setDumpText(e.target.value)}
          placeholder="Paste your resume, LinkedIn bio, or any background text…"
          disabled={extracting}
        />
        <div
          className={`pw-smartfill-dropzone ${dragOver ? 'asset-dropzone-over' : ''} ${extracting ? 'asset-dropzone-busy' : ''}`}
          onDragOver={(e) => { e.preventDefault(); if (!extracting) setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!extracting) handleFile(e.dataTransfer.files?.[0]); }}
          onClick={() => !extracting && fileRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (!extracting && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); } }}
          aria-label="Upload a file to extract facts"
          aria-busy={extracting}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.doc,.txt,.md,.rtf,.png,.jpg,.jpeg,.webp,.heic"
            hidden
            onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <FileText size={14} className="pw-smartfill-dropzone-icon" />
          <span className="pw-smartfill-dropzone-label">
            {extracting ? 'Reading…' : 'Drop a PDF, DOCX, image or screenshot - scanned files are OCR’d'}
          </span>
        </div>
        <button
          type="button"
          className="pw-btn-add pw-smartfill-btn"
          onClick={() => runExtract({ text: dumpText })}
          disabled={extracting || !dumpText.trim()}
        >
          {extracting ? <Loader2 className="pw-spin" size={14} /> : <Sparkles size={14} />}
          {extracting ? 'Extracting…' : 'Extract facts'}
        </button>
        {extractError && <p className="pw-error pw-smartfill-error">{extractError}</p>}
      </div>

      <div className="pw-or-divider">
        <span>- or add one -</span>
      </div>

      <div className="me-facts-add">
        <input
          className="pw-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Ran a 1,400-person developer conference, backed by Vercel"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
        />
        <button type="button" className="pw-btn-add" onClick={add} disabled={adding || !text.trim()}>
          {adding ? <Loader2 className="pw-spin" size={14} /> : <Plus size={14} />} Add
        </button>
      </div>

      {loading ? (
        <p className="pw-empty">Loading your facts…</p>
      ) : facts.length === 0 ? (
        <p className="pw-empty">No facts yet - paste your background above, or add one by hand.</p>
      ) : (
        <div className="pw-chips">
          {facts.map((f) => (
            <span key={f.id} className="pw-chip pw-chip-person">
              <Sparkles size={10} className="pw-chip-scope-icon" />
              {f.claim}
              <button type="button" className="pw-chip-x" aria-label="Remove" onClick={() => onRemoveFact(f.id)}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Résumé file box - same pipeline as Smart fill: upload → extract-context →
// person-level facts. Dropping a résumé pulls its facts into the profile.
// ---------------------------------------------------------------------------
function ResumeDropzone({
  userId,
  onFactsChanged,
}: {
  userId: string;
  onFactsChanged: () => void;
}) {
  const [extracting, setExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (file.size > MAX_ASSET_BYTES) {
      setError(`File too large. Max 20MB; this file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }
    setExtracting(true);
    setError(null);
    setResult(null);
    try {
      const asset = await uploadAsset({ userId, kind: 'context_dump', file });
      const { facts } = await agents.extractContext({ asset_id: asset.id });
      onFactsChanged();
      setResult(
        facts.length > 0
          ? `Added ${facts.length} fact${facts.length === 1 ? '' : 's'} from your résumé.`
          : 'Read your résumé - no new facts found.'
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed - try again.');
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div className="me-field me-resume-drop">
      <span className="me-field-label-row">
        <span className="me-field-label">Résumé</span>
      </span>
      <div
        className={`pw-smartfill-dropzone ${dragOver ? 'asset-dropzone-over' : ''} ${extracting ? 'asset-dropzone-busy' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!extracting) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!extracting) handleFile(e.dataTransfer.files?.[0]); }}
        onClick={() => !extracting && fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (!extracting && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current?.click(); } }}
        aria-label="Upload your résumé to extract facts"
        aria-busy={extracting}
      >
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.doc,.txt,.md,.rtf,.png,.jpg,.jpeg,.webp,.heic"
          hidden
          onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
        />
        {extracting ? <Loader2 size={14} className="pw-spin pw-smartfill-dropzone-icon" /> : <FileText size={14} className="pw-smartfill-dropzone-icon" />}
        <span className="pw-smartfill-dropzone-label">
          {extracting ? 'Reading your résumé…' : 'Drop your résumé (PDF, DOCX, image) - we’ll pull the facts out'}
        </span>
      </div>
      {result && <p className="section-hint">{result}</p>}
      {error && <p className="pw-error">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared panel + field chrome (matches the rest of the Me page)
// ---------------------------------------------------------------------------
function Panel({
  title,
  hint,
  open,
  score,
  onToggle,
  pip,
  children,
}: {
  title: string;
  hint: string;
  open: boolean;
  score: { filled: number; total: number };
  onToggle: () => void;
  pip?: string;
  children: React.ReactNode;
}) {
  const status: 'empty' | 'partial' | 'full' =
    score.filled === 0 ? 'empty' : score.filled < score.total ? 'partial' : 'full';
  return (
    <section className={`me-panel me-panel-${status}`} data-open={open}>
      <button type="button" className="me-panel-head" onClick={onToggle} aria-expanded={open}>
        <div className="me-panel-headline">
          <h2>{title}</h2>
          <p>{hint}</p>
        </div>
        <div className="me-panel-meta">
          <span className={`me-panel-pip me-panel-pip-${status}`}>{pip ?? `${score.filled}/${score.total}`}</span>
          <span className="me-panel-chev" aria-hidden>
            {open ? '–' : '+'}
          </span>
        </div>
      </button>
      {open && <div className="me-panel-body">{children}</div>}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="me-field">
      <span className="me-field-label-row">
        <span className="me-field-label">{label}</span>
      </span>
      {children}
    </label>
  );
}
