/** Coerce API/DB score values (number or numeric string) for display. */
export function asScore(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}
