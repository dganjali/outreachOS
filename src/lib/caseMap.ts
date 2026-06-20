// Shared key-case conversion + defensive fetch parsing.
//
// The Mongo schema stores docs in camelCase + `_id`; the frontend types
// (src/types.ts) use snake_case + `id`. Both data-access clients (src/lib/db.ts
// and src/lib/api.ts) need the exact same translation, so it lives here once
// instead of being reimplemented (and drifting) in each.

// Loosely-typed row. Callers cast to their concrete type.
export type Json = any;

// Frontend `id` is Mongo `_id`. Map explicitly so filters, ordering, and
// selected columns all hit the right field. Idempotent - `_id` stays `_id`.
export function camelKey(s: string): string {
  if (s === 'id' || s === '_id') return '_id';
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

// Inverse of camelKey - Mongo `_id` surfaces as `id` to the frontend so pages
// can read `row.id`. Idempotent.
export function snakeKey(s: string): string {
  if (s === '_id' || s === 'id') return 'id';
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function deepKeyMap(v: unknown, fn: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => deepKeyMap(x, fn));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // Preserve mongo operators ($in, $gte, etc.) - never rewrite them.
      const newKey = k.startsWith('$') ? k : fn(k);
      out[newKey] = deepKeyMap(val, fn);
    }
    return out;
  }
  return v;
}

export const toBackend = (v: unknown) => deepKeyMap(v, camelKey);
export const toFrontend = (v: unknown) => deepKeyMap(v, snakeKey);

// Parse a fetch response defensively. Infra layers (Cloud Run, load balancers)
// return plain-text bodies like "Service Unavailable" on 5xx, which would make
// res.json()/JSON.parse throw a cryptic "Unexpected token" error. Always read
// text first, surface a clean message on non-2xx, and only parse JSON on success.
export async function readJson<T>(res: Response, fallbackErr: string): Promise<T> {
  const txt = await res.text();
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const j = txt
        ? (JSON.parse(txt) as { error?: string; detail?: string; message?: string })
        : undefined;
      detail = j?.detail || j?.message || j?.error;
    } catch {
      // Non-JSON body (e.g. a gateway "Service Unavailable") - fall through.
    }
    throw new Error(detail || `${fallbackErr} (HTTP ${res.status})`);
  }
  try {
    return (txt ? JSON.parse(txt) : {}) as T;
  } catch {
    throw new Error(`${fallbackErr} (bad response)`);
  }
}
