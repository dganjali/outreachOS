import { Router } from 'express';
import { ContactStatus } from '@prisma/client';

import { prisma } from '../db/client.js';
import { requireUser } from '../middleware/auth.js';
import type { AuthedRequest } from '../types/index.js';
import { generateDraft } from '../services/draft.js';
import { searchDomain, verifyEmail, filterByRole } from '../services/hunter.js';
import { sendEmail } from '../services/gmail.js';

const router = Router();

// All contact routes assume a user session exists.
router.use(requireUser);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

router.post('/missions/:missionId/research', async (req: AuthedRequest, res) => {
  try {
    const { missionId } = req.params;

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    const mission = await prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission || mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Mission not found' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.session.userId } });
    const apiKey = user?.hunterApiKey ?? process.env.HUNTER_API_KEY;
    if (!apiKey) {
      return res.status(400).json({ success: false, error: 'Hunter API key not configured' });
    }

    const contacts = await prisma.contact.findMany({
      where: { missionId, status: ContactStatus.QUEUED }
    });

    for (const contact of contacts) {
      // Sequential loop is mandatory due to Hunter rate limits.
      await prisma.contact.update({
        where: { id: contact.id },
        data: { status: ContactStatus.RESEARCHING }
      });

      let domainContacts;
      try {
        domainContacts = await searchDomain(contact.domain, apiKey);
      } catch {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: ContactStatus.SKIPPED }
        });
        await sleep(1100);
        continue;
      }

      const filtered = await filterByRole(
        domainContacts,
        mission.targetCriteria,
        mission.contactsPerCompany
      );

      if (!filtered.length) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: ContactStatus.SKIPPED }
        });
        await sleep(1100);
        continue;
      }

      const primary = filtered[0];

      const verification = await verifyEmail(primary.email, apiKey);
      if (verification === 'undeliverable') {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: ContactStatus.SKIPPED }
        });
        await sleep(1100);
        continue;
      }

      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          email: primary.email,
          firstName: primary.firstName,
          lastName: primary.lastName,
          role: primary.role,
          confidence: primary.confidence,
          status: ContactStatus.PENDING_APPROVAL
        }
      });

      await sleep(1100);
    }

    const updatedContacts = await prisma.contact.findMany({ where: { missionId } });
    return res.json({ success: true, data: updatedContacts });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to research contacts';
    return res.status(500).json({ success: false, error: message });
  }
});

router.get('/missions/:missionId/queue', async (req: AuthedRequest, res) => {
  try {
    const { missionId } = req.params;

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    const mission = await prisma.mission.findUnique({ where: { id: missionId } });
    if (!mission || mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Mission not found' });
    }

    const contacts = await prisma.contact.findMany({
      where: { missionId, status: ContactStatus.PENDING_APPROVAL }
    });

    for (const contact of contacts) {
      if (!contact.draft) {
        const draft = generateDraft(contact, mission);
        await prisma.contact.update({
          where: { id: contact.id },
          data: { draft }
        });
      }
    }

    const withDrafts = await prisma.contact.findMany({
      where: { missionId, status: ContactStatus.PENDING_APPROVAL }
    });

    return res.json({ success: true, data: withDrafts });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to load approval queue';
    return res.status(500).json({ success: false, error: message });
  }
});

router.post('/contacts/:id/approve', async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;
    const { draft: editedDraft } = req.body as { draft?: string };

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    const contact = await prisma.contact.findUnique({
      where: { id },
      include: { mission: true }
    });

    if (!contact || contact.mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    if (!contact.email) {
      return res
        .status(400)
        .json({ success: false, error: 'Contact does not have an email address' });
    }

    const draft = editedDraft ?? contact.draft;
    if (!draft) {
      return res
        .status(400)
        .json({ success: false, error: 'No draft content available for this contact' });
    }

    const subject = `Quick question re: ${contact.domain}`;

    await sendEmail(req.session.userId, contact.email, subject, draft);

    await prisma.contact.update({
      where: { id },
      data: { status: ContactStatus.SENT }
    });

    return res.json({
      success: true,
      data: { contactId: contact.id, sentTo: contact.email }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to approve and send email';
    return res.status(500).json({ success: false, error: message });
  }
});

router.post('/contacts/:id/skip', async (req: AuthedRequest, res) => {
  try {
    const { id } = req.params;

    if (!req.session.userId) {
      return res.status(401).json({ success: false, error: 'No user session found' });
    }

    const contact = await prisma.contact.findUnique({
      where: { id },
      include: { mission: true }
    });

    if (!contact || contact.mission.userId !== req.session.userId) {
      return res.status(404).json({ success: false, error: 'Contact not found' });
    }

    await prisma.contact.update({
      where: { id },
      data: { status: ContactStatus.SKIPPED }
    });

    return res.json({ success: true, data: { contactId: contact.id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to skip contact';
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;


