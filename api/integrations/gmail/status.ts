import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../../_lib/auth';
import { adminClient } from '../../_lib/supabase';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const user = await requireUser(req, res);
  if (!user) return;

  const db = adminClient();
  const { data } = await db
    .from('user_integrations')
    .select('provider, provider_account_email, status, last_error, updated_at')
    .eq('user_id', user.id)
    .eq('provider', 'gmail')
    .maybeSingle();

  return res.status(200).json({ connected: !!data, integration: data ?? null });
}
