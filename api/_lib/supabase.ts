import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';

let _admin: SupabaseClient | null = null;

export function adminClient(): SupabaseClient {
  if (_admin) return _admin;
  _admin = createClient(env.SUPABASE_URL(), env.SUPABASE_SERVICE_ROLE_KEY(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

export function userClient(accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL(), env.SUPABASE_SERVICE_ROLE_KEY(), {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
