import type { Contact, Mission } from '@prisma/client';

export function generateDraft(contact: Contact, mission: Mission): string {
  const firstName = contact.firstName ?? 'there';
  const company = contact.domain;

  return `Hi ${firstName},

I came across ${company} and wanted to reach out.

${mission.ask}

Would love to find 15 minutes to connect — would that work?

Best,
[Your name]`;
}

