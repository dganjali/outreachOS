import { useState, useRef } from 'react';
import { supabase } from '../supabaseClient';

interface ParsedRow {
  company_name: string;
  domain?: string;
  why_now?: string;
  fit_reason?: string;
}

interface Props {
  missionId: string;
  onImported: () => void;
}

export function CsvImport({ missionId, onImported }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function parseCsv(input: string): ParsedRow[] {
    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];

    const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
    const rest = lines.slice(1);

    const nameIdx = findIdx(header, ['company', 'company_name', 'company name', 'name', 'organization', 'account']);
    const domainIdx = findIdx(header, ['domain', 'website', 'url', 'company domain']);
    const whyIdx = findIdx(header, ['why_now', 'why now', 'signal', 'note', 'notes']);
    const fitIdx = findIdx(header, ['fit', 'fit_reason', 'reason']);

    if (nameIdx === -1) {
      // No header row — treat each line as a company name.
      return [lines[0], ...rest].map((l): ParsedRow => ({ company_name: l }));
    }

    const out: ParsedRow[] = [];
    for (const row of rest) {
      const cols = splitCsvLine(row);
      const name = cols[nameIdx]?.trim();
      if (!name) continue;
      out.push({
        company_name: name,
        domain: domainIdx !== -1 ? cols[domainIdx]?.trim() || undefined : undefined,
        why_now: whyIdx !== -1 ? cols[whyIdx]?.trim() || undefined : undefined,
        fit_reason: fitIdx !== -1 ? cols[fitIdx]?.trim() || undefined : undefined,
      });
    }
    return out;
  }

  async function handleImport() {
    setError(null);
    const rows = parseCsv(text);
    if (rows.length === 0) {
      setError('No rows parsed. Include a header row with a "company" column, or one company per line.');
      return;
    }
    setImporting(true);
    const { error: err } = await supabase.from('targets').insert(
      rows.map((r) => ({
        mission_id: missionId,
        company_name: r.company_name,
        domain: r.domain ?? null,
        why_now: r.why_now ?? null,
        fit_reason: r.fit_reason ?? null,
        status: 'approved',
      }))
    );
    setImporting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setText('');
    setOpen(false);
    onImported();
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result ?? ''));
    reader.readAsText(file);
  }

  if (!open) {
    return (
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        Import CSV
      </button>
    );
  }

  return (
    <div className="csv-import">
      <div className="csv-import-head">
        <strong>Import targets from CSV</strong>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>×</button>
      </div>
      <p className="section-hint">
        Header row optional. Recognized columns: <code>company</code>, <code>domain</code>, <code>why_now</code>, <code>fit_reason</code>. Or paste one company per line.
      </p>
      <textarea
        rows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`company,domain,why_now\nVercel,vercel.com,Sponsored 6 hackathons in 2025\nLinear,linear.app,Just launched Linear for Designers`}
      />
      <div className="csv-import-actions">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()}>
          Upload .csv
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={importing || !text.trim()}
          onClick={handleImport}
        >
          {importing ? 'Importing…' : 'Import'}
        </button>
      </div>
      {error && <p role="alert" className="banner-error">{error}</p>}
    </div>
  );
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') {
        out.push(cur);
        cur = '';
      } else if (ch === '"') {
        inQuotes = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

function findIdx(headers: string[], candidates: string[]): number {
  for (const c of candidates) {
    const i = headers.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}
