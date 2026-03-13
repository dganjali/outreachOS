import type { NextFunction, Response } from 'express';

import { prisma } from '../db/client.js';
import type { AuthedRequest } from '../types/index.js';

/**
 * MVP auth stub: ensures req.session.userId exists for local development.
 * This is intentionally simple and should be replaced with real auth later.
 */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    if (req.session.userId) return next();

    const email = 'dev@example.com';
    const user =
      (await prisma.user.findUnique({ where: { email } })) ??
      (await prisma.user.create({ data: { email } }));

    req.session.userId = user.id;
    return next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error creating dev user session';
    return res.status(500).json({ success: false, error: message });
  }
}

