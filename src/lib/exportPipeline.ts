// Client-side pipeline export. Joins the user's own data and downloads a CSV.
// No backend, no third-party CRM. The blob is generated locally from data the
// user already has loaded.

import { supabase } from '../supabaseClient';

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

interface Row { id: string; [k: string]: unknown }

export async function exportPipelineCsv(): Promise<number> {
  const [missions, targets, contacts, sequences] = await Promise.all([
    supabase.from('missions').select('*'),
    supabase.from('targets').select('*'),
    supabase.from('contacts').select('*'),
    supabase.from('email_sequences').select('*'),
  ]);

  const mById = new Map<string, Row>(((missions.data ?? []) as Row[]).map((m) => [m.id, m]));
  const tById = new Map<string, Row>(((targets.data ?? []) as Row[]).map((t) => [t.id, t]));
  const seqByContact = new Map<string, Row>();
  for (const s of (sequences.data ?? []) as Row[]) seqByContact.set(String(s.contact_id), s);

  const header = ['Mission', 'Company', 'Contact', 'Title', 'Email', 'Contact status', 'Sequence status', 'Subject'];
  const rows = ((contacts.data ?? []) as Row[]).map((c) => {
    const t = tById.get(String(c.target_id));
    const m = t ? mById.get(String(t.mission_id)) : null;
    const seq = seqByContact.get(c.id);
    return [
      m?.name ?? '',
      t?.company_name ?? '',
      c.name ?? '',
      c.title ?? '',
      c.email ?? '',
      c.status ?? '',
      seq?.status ?? '',
      seq?.subject ?? '',
    ];
  });

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `outreachos-pipeline-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return rows.length;
}
