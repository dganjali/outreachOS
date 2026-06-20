// Frontend data-access shim. Mimics enough of the old Supabase chain API to
// keep existing pages working with minimal churn. Under the hood it talks to
// `/api/data/:collection/*` and sends the Firebase ID token.
//
// IMPORTANT field-name translation:
//   The new Mongo schema uses camelCase (missionId, createdAt). The frontend
//   types (src/types.ts) still use snake_case (mission_id, created_at). This
//   shim performs deep snake_case ↔ camelCase conversion so pages don't all
//   need rewrites.

import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updatePassword,
  signOut as fbSignOut,
} from 'firebase/auth';
import { auth, currentIdToken } from '../firebaseClient';
import { camelKey as camel, toBackend, toFrontend, readJson, type Json } from './caseMap';

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = await currentIdToken();
  if (!token) throw new Error('Not signed in');
  const hasBody = init?.body !== undefined;
  const res = await fetch(`/api/data${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    body: hasBody ? JSON.stringify(init!.body) : undefined,
  });
  const j = await readJson<{ data?: unknown }>(res, 'Request failed');
  return toFrontend(j.data) as T;
}

// ---------------------------------------------------------------------------
// Collection name translation: old Postgres → new Mongo
// Most map 1:1 since I kept names. The migration uses Mongo names verbatim.
// ---------------------------------------------------------------------------
function collectionName(t: string): string {
  // Identity mapping today (old Supabase tables already use the same names
  // as Mongo collections). Left as a function so we can patch in renames.
  return t;
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------
interface QueryOpts {
  count?: 'exact' | null;
  head?: boolean;
}

class Query<T = Json> {
  private filter: Json = {};
  private sortKey: { key: string; dir: 1 | -1 } | null = null;
  private take: number | null = null;
  constructor(private collection: string, private opts: QueryOpts = {}) {}

  eq(field: string, value: unknown): this {
    this.filter[camel(field)] = value;
    return this;
  }
  in(field: string, values: unknown[]): this {
    this.filter[camel(field)] = { $in: values };
    return this;
  }
  not(field: string, op: 'is', value: null | 'null'): this {
    void op;
    if (value === null || value === 'null') {
      this.filter[camel(field)] = { $ne: null };
    }
    return this;
  }
  is(field: string, value: null | 'null'): this {
    if (value === null || value === 'null') {
      this.filter[camel(field)] = null;
    }
    return this;
  }
  gte(field: string, value: unknown): this {
    const k = camel(field);
    const existing = typeof this.filter[k] === 'object' && this.filter[k] ? (this.filter[k] as Json) : {};
    this.filter[k] = { ...existing, $gte: value };
    return this;
  }
  order(field: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    void opts?.nullsFirst; // Supabase-only knob; Mongo ignores.
    this.sortKey = { key: camel(field), dir: opts?.ascending === false ? -1 : 1 };
    return this;
  }
  limit(n: number): this {
    this.take = n;
    return this;
  }

  private async exec(): Promise<{ data: T[] | null; error: { message: string } | null; count?: number }> {
    try {
      // count:'exact' + head:true is a pure count - ask the server to run a
      // Mongo countDocuments() and skip shipping the documents entirely
      // (previously the shim downloaded every matching row and took .length).
      const countOnly = this.opts.head === true && this.opts.count === 'exact';
      const token = await currentIdToken();
      if (!token) throw new Error('Not signed in');
      const res = await fetch(`/api/data/${collectionName(this.collection)}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter: toBackend(this.filter),
          sort: this.sortKey ? { [this.sortKey.key]: this.sortKey.dir } : undefined,
          limit: this.take ?? undefined,
          count: countOnly || undefined,
        }),
      });
      const j = await readJson<{ data?: unknown; count?: number }>(res, 'Request failed');
      if (countOnly) {
        return { data: null, count: typeof j.count === 'number' ? j.count : 0, error: null };
      }
      const arr = toFrontend(j.data) as T[];
      return { data: arr, count: typeof j.count === 'number' ? j.count : arr.length, error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : 'unknown_error' } };
    }
  }

  async single(): Promise<{ data: T | null; error: { message: string } | null }> {
    this.take = 1;
    const r = await this.exec();
    return { data: r.data?.[0] ?? null, error: r.error };
  }
  async maybeSingle() { return this.single(); }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: T[] | null; error: { message: string } | null; count?: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled as any, onrejected as any);
  }
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------
class Mutation<T = Json> {
  private idValue: string | null = null;
  constructor(private collection: string, private kind: 'insert' | 'update' | 'delete', private body: unknown) {}
  select(_cols = '*'): this { void _cols; return this; }
  eq(field: string, value: string | number): this {
    if (field === 'id' || field === '_id') this.idValue = String(value);
    return this;
  }
  async single(): Promise<{ data: T | null; error: { message: string } | null }> {
    try {
      const data = await this.run();
      return { data: data as T, error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : 'unknown_error' } };
    }
  }
  private async run(): Promise<unknown> {
    if (this.kind === 'insert') {
      const arr = Array.isArray(this.body) ? this.body : [this.body];
      const results = [];
      for (const item of arr) {
        results.push(await call(`/${collectionName(this.collection)}`, { method: 'POST', body: toBackend(item) }));
      }
      return Array.isArray(this.body) ? results : results[0];
    }
    if (this.kind === 'update') {
      if (!this.idValue) throw new Error('update requires .eq("id", id)');
      return call(`/${collectionName(this.collection)}/${this.idValue}`, { method: 'PATCH', body: toBackend(this.body) });
    }
    if (!this.idValue) throw new Error('delete requires .eq("id", id)');
    return call(`/${collectionName(this.collection)}/${this.idValue}`, { method: 'DELETE' });
  }
  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: T | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.single().then(onfulfilled as any, onrejected as any);
  }
}

// InsertMutation: thenable, terminator returns array of inserted rows.
class InsertMutation<T = Json> {
  constructor(private _collection: string, private _body: unknown) {}
  select(_cols = '*'): this { void _cols; return this; }
  async single(): Promise<{ data: T | null; error: { message: string } | null }> {
    const r = await this.exec();
    if (r.error) return { data: null, error: r.error };
    return { data: (r.data?.[0] ?? null) as T | null, error: null };
  }
  private async exec(): Promise<{ data: T[] | null; error: { message: string } | null }> {
    try {
      const arr = Array.isArray(this._body) ? this._body : [this._body];
      const results: unknown[] = [];
      for (const item of arr) {
        results.push(await call(`/${this._collection}`, { method: 'POST', body: toBackend(item) }));
      }
      return { data: results as T[], error: null };
    } catch (err) {
      return { data: null, error: { message: err instanceof Error ? err.message : 'unknown_error' } };
    }
  }
  then<TResult1 = { data: T[] | null; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: T[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.exec().then(onfulfilled as any, onrejected as any);
  }
}

class TableHandle {
  constructor(private collection: string) {}
  select(_cols = '*', opts?: { count?: 'exact'; head?: boolean }): Query<Json> {
    void _cols;
    return new Query(this.collection, opts);
  }
  insert(body: unknown): InsertMutation { return new InsertMutation(this.collection, body); }
  update(body: unknown): Mutation { return new Mutation(this.collection, 'update', body); }
  delete(): Mutation { return new Mutation(this.collection, 'delete', undefined); }
  upsert(body: unknown, _opts?: { onConflict?: string }): Mutation {
    void _opts;
    return new Mutation(this.collection, 'insert', body);
  }
}

// ---------------------------------------------------------------------------
// Auth shim (mirrors the Supabase auth call sites we use)
// ---------------------------------------------------------------------------
// Supabase-shaped user wrapper so pages reading user.email_confirmed_at / id
// keep working.
function compatUser(u: import('firebase/auth').User | null) {
  if (!u) return null;
  return {
    id: u.uid,
    email: u.email,
    email_confirmed_at: u.emailVerified ? new Date().toISOString() : null,
  };
}

const authShim = {
  async getSession() {
    const u = auth.currentUser;
    return {
      data: {
        session: u ? { user: compatUser(u), access_token: await currentIdToken() } : null,
      },
    };
  },
  async getUser() {
    return { data: { user: compatUser(auth.currentUser) } };
  },
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    try {
      const cred = await signInWithEmailAndPassword(auth, email, password);
      return { data: { user: compatUser(cred.user), session: { user: compatUser(cred.user) } }, error: null };
    } catch (err) {
      return { data: { user: null, session: null }, error: { message: err instanceof Error ? err.message : 'sign_in_failed' } };
    }
  },
  async signUp({ email, password }: { email: string; password: string }) {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(cred.user).catch(() => undefined);
      // session is null until email is verified (mirrors Supabase's confirm-email flow).
      return { data: { user: compatUser(cred.user), session: cred.user.emailVerified ? { user: compatUser(cred.user) } : null }, error: null };
    } catch (err) {
      return { data: { user: null, session: null }, error: { message: err instanceof Error ? err.message : 'sign_up_failed' } };
    }
  },
  async signOut() {
    await fbSignOut(auth);
    return { error: null };
  },
  async resetPasswordForEmail(email: string, _opts?: { redirectTo?: string }) {
    void _opts;
    try {
      await sendPasswordResetEmail(auth, email);
      return { error: null };
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : 'reset_failed' } };
    }
  },
  async resend(_args: { type: 'signup'; email: string }) {
    void _args;
    try {
      if (auth.currentUser) await sendEmailVerification(auth.currentUser);
      return { error: null };
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : 'resend_failed' } };
    }
  },
  async updateUser(args: { password?: string }) {
    try {
      if (args.password && auth.currentUser) await updatePassword(auth.currentUser, args.password);
      return { error: null };
    } catch (err) {
      return { error: { message: err instanceof Error ? err.message : 'update_failed' } };
    }
  },
  // onAuthStateChange returns a Supabase-shaped subscription wrapper.
  onAuthStateChange(_cb: (event: string, session: unknown) => void) {
    void _cb;
    return { data: { subscription: { unsubscribe: () => undefined } } };
  },
};

// ---------------------------------------------------------------------------
// Storage shim (Google Cloud Storage via signed URLs).
// Frontend POSTs to /api/data/_storage/sign for an upload URL, PUTs the
// bytes, then registers the asset row separately.
// ---------------------------------------------------------------------------
const storageShim = {
  from(_bucket: string) {
    void _bucket;
    return {
      async upload(path: string, file: File, _opts?: { upsert?: boolean; contentType?: string }): Promise<{ data: { path: string } | null; error: { message: string } | null }> {
        void _opts;
        try {
          const token = await currentIdToken();
          if (!token) throw new Error('Not signed in');
          const signRes = await fetch('/api/data/_storage/sign-upload', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, contentType: file.type || 'application/octet-stream' }),
          });
          const sj = await readJson<{ data: { url: string; path: string } }>(signRes, 'Upload unavailable');
          const putRes = await fetch(sj.data.url, {
            method: 'PUT',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          });
          if (!putRes.ok) throw new Error('upload_put_failed');
          return { data: { path: sj.data.path }, error: null };
        } catch (err) {
          return { data: null, error: { message: err instanceof Error ? err.message : 'upload_failed' } };
        }
      },
      async remove(paths: string[]): Promise<{ error: { message: string } | null }> {
        try {
          const token = await currentIdToken();
          if (!token) throw new Error('Not signed in');
          const res = await fetch('/api/data/_storage/remove', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
          });
          // Surface a failed delete (403 forbidden, 5xx, partial failure)
          // instead of silently reporting success - callers update UI on it.
          const j = await readJson<{ ok?: boolean; removed?: number; failed?: number }>(res, 'Remove failed');
          if (j.failed && j.failed > 0) {
            return { error: { message: `Failed to remove ${j.failed} file(s)` } };
          }
          return { error: null };
        } catch (err) {
          return { error: { message: err instanceof Error ? err.message : 'remove_failed' } };
        }
      },
      async createSignedUrl(path: string, _ttl: number): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }> {
        try {
          const token = await currentIdToken();
          if (!token) throw new Error('Not signed in');
          const r = await fetch('/api/data/_storage/sign-download', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ path, ttlSeconds: _ttl }),
          });
          const j = await readJson<{ data: { url: string } }>(r, 'Download unavailable');
          return { data: { signedUrl: j.data.url }, error: null };
        } catch (err) {
          return { data: null, error: { message: err instanceof Error ? err.message : 'sign_failed' } };
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
export const db = {
  from: (collection: string) => new TableHandle(collection),
  auth: authShim,
  storage: storageShim,
};
