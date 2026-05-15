import { useEffect, useRef, useState } from 'react';
import type { ProfileAsset, ProfileAssetKind } from '../../types';
import {
  deleteAsset,
  listAssets,
  MAX_ASSET_BYTES,
  signedAssetUrl,
  uploadAsset,
} from '../../lib/profileAssets';

interface AssetUploaderProps {
  userId: string;
  /** Bumped when an external action (e.g. parse completion) wants the asset list to refresh. */
  reloadKey: number;
  onUploaded: (asset: ProfileAsset) => void;
  onError: (msg: string) => void;
}

const KIND_LABEL: Record<Extract<ProfileAssetKind, 'resume' | 'portfolio_pdf'>, string> = {
  resume: 'Resume',
  portfolio_pdf: 'Portfolio PDF',
};

const KIND_HINT: Record<Extract<ProfileAssetKind, 'resume' | 'portfolio_pdf'>, string> = {
  resume: 'PDF, up to 2MB. Triggers an agent that suggests profile updates.',
  portfolio_pdf: 'PDF, up to 2MB. Stored for later reference — not parsed.',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function AssetUploader({ userId, reloadKey, onUploaded, onError }: AssetUploaderProps) {
  const [assets, setAssets] = useState<ProfileAsset[] | null>(null);
  const [busyKind, setBusyKind] = useState<ProfileAssetKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAssets(userId)
      .then((rows) => {
        if (!cancelled) setAssets(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        onError(err instanceof Error ? err.message : 'Failed to load assets');
        setAssets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey, onError]);

  async function handleFile(kind: ProfileAssetKind, file: File) {
    setBusyKind(kind);
    try {
      const asset = await uploadAsset({ userId, kind, file });
      setAssets((prev) => (prev ? [asset, ...prev] : [asset]));
      onUploaded(asset);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusyKind(null);
    }
  }

  async function handleDelete(asset: ProfileAsset) {
    if (!confirm(`Delete ${asset.file_name}? This cannot be undone.`)) return;
    try {
      await deleteAsset(asset);
      setAssets((prev) => prev?.filter((a) => a.id !== asset.id) ?? null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  async function handleOpen(asset: ProfileAsset) {
    const url = await signedAssetUrl(asset);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else onError('Could not generate a download link.');
  }

  return (
    <div className="asset-uploader">
      <div className="asset-uploader-grid">
        <Dropzone
          kind="resume"
          accept="application/pdf"
          label={KIND_LABEL.resume}
          hint={KIND_HINT.resume}
          busy={busyKind === 'resume'}
          onFile={(f) => handleFile('resume', f)}
        />
        <Dropzone
          kind="portfolio_pdf"
          accept="application/pdf"
          label={KIND_LABEL.portfolio_pdf}
          hint={KIND_HINT.portfolio_pdf}
          busy={busyKind === 'portfolio_pdf'}
          onFile={(f) => handleFile('portfolio_pdf', f)}
        />
      </div>

      {assets === null ? (
        <p className="asset-list-empty">Loading uploads…</p>
      ) : assets.length === 0 ? null : (
        <ul className="asset-list">
          {assets.map((a) => (
            <li key={a.id} className="asset-row">
              <div className="asset-row-main">
                <span className={`asset-row-kind asset-row-kind-${a.kind}`}>
                  {a.kind === 'resume'
                    ? 'Resume'
                    : a.kind === 'portfolio_pdf'
                      ? 'Portfolio'
                      : a.kind}
                </span>
                <div className="asset-row-meta">
                  <button
                    type="button"
                    className="asset-row-name"
                    onClick={() => handleOpen(a)}
                    title="Open in a new tab"
                  >
                    {a.file_name}
                  </button>
                  <span className="asset-row-size">{formatBytes(a.file_size)}</span>
                  {a.kind === 'resume' &&
                    (a.parsed_at ? (
                      <span className="asset-row-tag asset-row-tag-parsed">parsed</span>
                    ) : a.parse_error ? (
                      <span
                        className="asset-row-tag asset-row-tag-error"
                        title={a.parse_error}
                      >
                        parse failed
                      </span>
                    ) : null)}
                </div>
              </div>
              <button
                type="button"
                className="asset-row-delete"
                onClick={() => handleDelete(a)}
                aria-label={`Delete ${a.file_name}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Dropzone({
  kind,
  label,
  hint,
  accept,
  busy,
  onFile,
}: {
  kind: ProfileAssetKind;
  label: string;
  hint: string;
  accept: string;
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function pick(file: File | null | undefined) {
    if (!file) return;
    if (file.size > MAX_ASSET_BYTES) {
      // Surface the same message uploadAsset would throw so users see it before they wait.
      alert(`File too large. Max 2MB; this file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }
    onFile(file);
  }

  return (
    <div
      className={`asset-dropzone ${dragOver ? 'asset-dropzone-over' : ''} ${busy ? 'asset-dropzone-busy' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (busy) return;
        pick(e.dataTransfer.files?.[0]);
      }}
      onClick={() => !busy && inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!busy && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      aria-label={`Upload ${label}`}
      aria-busy={busy}
      data-kind={kind}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="asset-dropzone-label">{label}</div>
      <div className="asset-dropzone-hint">{busy ? 'Uploading…' : hint}</div>
      <div className="asset-dropzone-cta">{busy ? '' : 'Drop a PDF or click to choose'}</div>
    </div>
  );
}
