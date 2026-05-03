import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, methodNotAllowed } from '../../_lib/auth';
import { authUrl } from '../../_lib/gmail';
import { encrypt } from '../../_lib/crypto';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = await requireUser(req, res);
  if (!user) return;

  const origin = (req.body as { origin?: string } | null)?.origin || `https://${req.headers.host}`;
  const redirectUri = `${origin}/api/integrations/gmail/callback`;

  // Encode user_id + nonce + timestamp into the state. Encrypted so we don't trust the round-trip.
  const state = encrypt(JSON.stringify({ uid: user.id, t: Date.now(), redirect: redirectUri }));

  return res.status(200).json({ url: authUrl(state, redirectUri) });
}
