import type { VercelRequest, VercelResponse } from '@vercel/node';
import { adminClient } from './supabase';

export interface AuthedUser {
  id: string;
  email: string | null;
}

export async function requireUser(
  req: VercelRequest,
  res: VercelResponse
): Promise<AuthedUser | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_authorization' });
    return null;
  }
  const token = header.slice(7);
  const admin = adminClient();
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
  return { id: data.user.id, email: data.user.email ?? null };
}

export function methodNotAllowed(res: VercelResponse, allow: string[]) {
  res.setHeader('Allow', allow.join(', '));
  res.status(405).json({ error: 'method_not_allowed' });
}
