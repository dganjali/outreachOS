import { ContactStatus, type Mission } from '@prisma/client';

import { prisma } from '../db/client.js';
import { generateRationale } from './rationale.js';

export interface CreateMissionParams {
  userId: string;
  name: string;
  ask: string;
  targetCriteria: string;
  contactsPerCompany: number;
  companyList: string[];
}

function normaliseDomain(raw: string): string {
  return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/g, '').trim();
}

export async function createMission({
  userId,
  name,
  ask,
  targetCriteria,
  contactsPerCompany,
  companyList
}: CreateMissionParams): Promise<{ mission: Mission; contacts: { id: string; domain: string }[] }> {
  const normalisedCompanies = companyList.map(normaliseDomain).filter(Boolean);

  const rationale = await generateRationale(
    normalisedCompanies,
    targetCriteria,
    ask,
    contactsPerCompany
  );

  const mission = await prisma.mission.create({
    data: {
      userId,
      name,
      ask,
      targetCriteria,
      contactsPerCompany,
      rationale,
      status: 'DRAFT'
    }
  });

  const contactsToCreate = normalisedCompanies.map((domain) => ({
    missionId: mission.id,
    domain,
    status: ContactStatus.QUEUED
  }));

  await prisma.contact.createMany({
    data: contactsToCreate
  });

  const contacts = await prisma.contact.findMany({
    where: { missionId: mission.id }
  });

  return { mission, contacts: contacts.map((c) => ({ id: c.id, domain: c.domain })) };
}

