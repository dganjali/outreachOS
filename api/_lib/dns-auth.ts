// Sender-domain authentication check. Run at Gmail connect (and on demand) so we
// can warn a user whose custom domain isn't set up to authenticate - the biggest
// avoidable deliverability problem. A @gmail.com sender is authenticated by
// Google, so there is nothing to configure.
//
// We only read public DNS TXT records (SPF, DMARC, a Google DKIM selector); no
// HTTP, so there is no SSRF surface. The resolver is injectable for tests.

import { resolveTxt as nodeResolveTxt } from 'node:dns/promises';

export type DomainAuth = 'gmail' | 'ok' | 'partial' | 'missing';

export interface DeliverabilityHealth {
  domainAuth: DomainAuth;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  checkedAt: Date;
}

export type TxtResolver = (host: string) => Promise<string[][]>;

const GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

async function txt(resolver: TxtResolver, host: string): Promise<string[]> {
  try {
    const records = await resolver(host);
    // node returns string[][] (each record may be split into chunks); join chunks.
    return records.map((chunks) => chunks.join(''));
  } catch {
    return []; // NXDOMAIN / no record / lookup error ⇒ treat as absent
  }
}

export async function checkDomainAuth(
  fromEmail: string,
  resolver: TxtResolver = nodeResolveTxt,
  now: Date = new Date(),
): Promise<DeliverabilityHealth> {
  const domain = domainOf(fromEmail);
  if (!domain) {
    return { domainAuth: 'missing', spf: false, dkim: false, dmarc: false, checkedAt: now };
  }
  if (GOOGLE_DOMAINS.has(domain)) {
    return { domainAuth: 'gmail', spf: true, dkim: true, dmarc: true, checkedAt: now };
  }

  const [root, dmarcRecs, dkimRecs] = await Promise.all([
    txt(resolver, domain),
    txt(resolver, `_dmarc.${domain}`),
    txt(resolver, `google._domainkey.${domain}`),
  ]);

  const spf = root.some((r) => /v=spf1/i.test(r));
  const dmarc = dmarcRecs.some((r) => /v=DMARC1/i.test(r));
  const dkim = dkimRecs.some((r) => /v=DKIM1|k=rsa|p=/i.test(r));

  // SPF + DMARC are the high-signal pair; DKIM via the Google selector is
  // best-effort (a custom selector wouldn't be found here).
  const passing = [spf, dmarc].filter(Boolean).length;
  const domainAuth: DomainAuth = passing === 2 ? 'ok' : passing === 1 ? 'partial' : 'missing';
  return { domainAuth, spf, dkim, dmarc, checkedAt: now };
}
