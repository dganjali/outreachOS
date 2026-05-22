import type { Request, Response } from 'express';
import { exchangeCode, fetchGoogleUserEmail, GMAIL_SCOPES, upsertGmailIntegration } from '../../_lib/gmail';
import { decrypt } from '../../_lib/crypto';

export default async function handler(req: Request, res: Response) {
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

  // 10-minute window
  if (Date.now() - state.t > 10 * 60 * 1000) {
    return redirectBack(res, 'error=state_expired');
  }

  try {
    const tokens = await exchangeCode(code, state.redirect);

    const grantedScopes = new Set(tokens.scope.split(' '));
    const requiredScopes = GMAIL_SCOPES.filter((s) => s !== 'openid');
    const missing = requiredScopes.filter((s) => !grantedScopes.has(s));
    if (missing.length > 0) {
      return redirectBack(res, `error=${encodeURIComponent('missing_scopes')}`);
    }

    const email = await fetchGoogleUserEmail(tokens.access_token);

    await upsertGmailIntegration({
      uid: state.uid,
      email,
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      expiresInSec: tokens.expires_in,
      scopes: tokens.scope,
    });

    return redirectBack(res, 'connected=gmail');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'callback_failed';
    return redirectBack(res, `error=${encodeURIComponent(msg.slice(0, 200))}`);
  }
}

function redirectBack(res: Response, qs: string) {
  res.setHeader('Location', `/settings?${qs}`);
  res.status(302).end();
}
