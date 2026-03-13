import { Router } from 'express';

import { prisma } from '../db/client.js';
import { requireUser } from '../middleware/auth.js';
import type { AuthedRequest } from '../types/index.js';
import { createMission } from '../services/mission.js';

const router = Router();

// All mission routes assume a user session exists.
router.use(requireUser);

router.post('/', async (req: AuthedRequest, res) => {
  try {
    const { name, ask, targetCriteria, contactsPerCompany, companies } = req.body as {
      name?: string;
      ask?: string;
      targetCriteria?: string;
      contactsPerCompany?: number;
      companies?: string[];
    };

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    if (!name || !ask || !targetCriteria || !Array.isArray(companies) || !companies.length) {
      return res.status(400).json({ success: false, error: 'Missing required mission fields' });
    }

    const perCompany = contactsPerCompany && contactsPerCompany > 0 ? contactsPerCompany : 1;

    const { mission, contacts } = await createMission({
      userId: req.session.userId,
      name,
      ask,
      targetCriteria,
      contactsPerCompany: perCompany,
      companyList: companies
    });

    return res.json({ success: true, data: { mission, contacts } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create mission';
    return res.status(500).json({ success: false, error: message });
  }
});

router.post('/:id/confirm', async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    const mission = await prisma.mission.findUnique({ where: { id } });
    if (!mission || mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Mission not found' });
    }

    await prisma.mission.update({
      where: { id },
      data: { status: 'ACTIVE' }
    });

    return res.json({ success: true, data: { id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to confirm mission';
    return res.status(500).json({ success: false, error: message });
  }
});

router.patch('/:id/rationale', async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;
    const { rationale } = req.body as { rationale?: string };

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    if (typeof rationale !== 'string') {
      return res.status(400).json({ success: false, error: 'rationale must be a string' });
    }

    const mission = await prisma.mission.findUnique({ where: { id } });
    if (!mission || mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Mission not found' });
    }

    await prisma.mission.update({
      where: { id },
      data: { rationale }
    });

    return res.json({ success: true, data: { id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to update mission rationale';
    return res.status(500).json({ success: false, error: message });
  }
});

router.get('/:id', async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    const mission = await prisma.mission.findUnique({
      where: { id },
      include: { contacts: true }
    });

    if (!mission || mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Mission not found' });
    }

    return res.json({ success: true, data: mission });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch mission';
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;


