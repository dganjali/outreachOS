import { requireUser, methodNotAllowed } from '../../_lib/auth';
import { forUser } from '../../_lib/db';
import { decrypt } from '../../_lib/crypto';
import { revokeToken } from '../../_lib/gmail';
export default async function handler(req, res) {
    if (req.method !== 'POST')
        return methodNotAllowed(res, ['POST']);
    const user = await requireUser(req, res);
    if (!user)
        return;
    const scope = forUser(user.id);
    const row = await scope
        .collection('user_integrations')
        .findOne({ provider: 'gmail' });
    if (row?.refreshTokenEncrypted) {
        try {
            await revokeToken(decrypt(row.refreshTokenEncrypted));
        }
        catch {
            // Best-effort revoke; still delete the row below.
        }
    }
    await scope
        .collection('user_integrations')
        .deleteOne({ provider: 'gmail' });
    return res.status(200).json({ disconnected: true });
}
