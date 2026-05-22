import { requireUser, methodNotAllowed } from '../../_lib/auth';
import { authUrl } from '../../_lib/gmail';
import { encrypt } from '../../_lib/crypto';
export default async function handler(req, res) {
    if (req.method !== 'POST')
        return methodNotAllowed(res, ['POST']);
    const user = await requireUser(req, res);
    if (!user)
        return;
    const origin = req.body?.origin || `https://${req.headers.host}`;
    const redirectUri = `${origin}/api/integrations/gmail/callback`;
    // Encrypted state — round-trips through Google, we don't trust it on return.
    const state = encrypt(JSON.stringify({ uid: user.id, t: Date.now(), redirect: redirectUri }));
    return res.status(200).json({ url: authUrl(state, redirectUri) });
}
