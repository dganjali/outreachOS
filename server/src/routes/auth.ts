import { Router } from 'express';

import { handleCallback, getAuthUrl } from '../services/gmail.js';
import { requireUser } from '../middleware/auth.js';
import type { AuthedRequest } from '../types/index.js';

const router = Router();

router.get('/gmail', requireUser, (_req, res) => {
  try {
    const url = getAuthUrl();
    res.redirect(url);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate Gmail authorization URL';
    res.status(500).json({ success: false, error: message });
  }
});

router.get('/gmail/callback', requireUser, async (req: AuthedRequest, res) => {
  try {
    const code = req.query.code;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing code query parameter' });
    }

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    await handleCallback(code, req.session.userId);

    // For now, redirect to a dashboard route that the frontend can handle.
    res.redirect('/dashboard');
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to handle Gmail OAuth callback';
    res.status(500).json({ success: false, error: message });
  }
});

export default router;


