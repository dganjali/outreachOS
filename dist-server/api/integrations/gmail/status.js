import { requireUser, methodNotAllowed } from '../../_lib/auth';
import { forUser } from '../../_lib/db';
export default async function handler(req, res) {
    if (req.method !== 'GET')
        return methodNotAllowed(res, ['GET']);
    const user = await requireUser(req, res);
    if (!user)
        return;
    const scope = forUser(user.id);
    const row = await scope
        .collection('user_integrations')
        .findOne({ provider: 'gmail' });
    if (!row)
        return res.status(200).json({ connected: false, integration: null });
    // Don't leak encrypted token columns.
    return res.status(200).json({
        connected: true,
        integration: {
            provider: row.provider,
            provider_account_email: row.providerAccountEmail,
            status: row.status,
            last_error: row.lastError,
            updated_at: row.updatedAt,
        },
    });
}
