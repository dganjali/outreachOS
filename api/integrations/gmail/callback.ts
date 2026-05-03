import type { VercelRequest, VercelResponse } from '@vercel/node';
import { adminClient } from '../../_lib/supabase';
import { exchangeCode, fetchGoogleUserEmail } from '../../_lib/gmail';
import { encrypt, decrypt } from '../../_lib/crypto';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).end();
  }

  const code = (req.query.code as string | undefined) ?? '';
  const stateRaw = (req.query.state as string | undefined) ?? '';
  const errorParam = req.query.error as string | undefined;

  if (errorParam) return redirectBack(res, `error=${encodeURIComponent(errorParam)}`);
  if (!code || !stateRaw) return redirectBack(res, 'error=missing_params');

  let state: { uid: string; t: number; redirect: string };
  try {
    state = JSON.parse(decrypt(stateRaw));
  } catch {
    return redirectBack(res, 'error=invalid_state');
  }

  // 10 minute window
  if (Date.now() - state.t > 10 * 60 * 1000) {
    return redirectBack(res, 'error=state_expired');
  }

  try {
    const tokens = await exchangeCode(code, state.redirect);
    const email = await fetchGoogleUserEmail(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const db = adminClient();
    const { error } = await db.from('user_integrations').upsert(
      {
        user_id: state.uid,
        provider: 'gmail',
        provider_account_email: email,
        refresh_token_encrypted: encrypt(tokens.refresh_token),
        access_token_encrypted: encrypt(tokens.access_token),
        access_token_expires_at: expiresAt,
        scopes: tokens.scope,
        status: 'active',
        last_error: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,provider' }
    );

    if (error) return redirectBack(res, `error=${encodeURIComponent(error.message)}`);
    return redirectBack(res, 'connected=gmail');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'callback_failed';
    return redirectBack(res, `error=${encodeURIComponent(msg.slice(0, 200))}`);
  }
}

function redirectBack(res: VercelResponse, qs: string) {
  res.setHeader('Location', `/settings?${qs}`);
  res.status(302).end();
}
