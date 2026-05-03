import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../../_lib/auth';
import { adminClient } from '../../_lib/supabase';
import { decrypt } from '../../_lib/crypto';
import { revokeToken } from '../../_lib/gmail';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const db = adminClient();
  const { data } = await db
    .from('user_integrations')
    .select('id, refresh_token_encrypted')
    .eq('user_id', user.id)
    .eq('provider', 'gmail')
    .maybeSingle();

  if (data?.refresh_token_encrypted) {
    try {
      await revokeToken(decrypt(data.refresh_token_encrypted));
    } catch {
      // Best-effort revoke; still delete the row below.
    }
  }
  await db.from('user_integrations').delete().eq('user_id', user.id).eq('provider', 'gmail');
  return res.status(200).json({ disconnected: true });
}
