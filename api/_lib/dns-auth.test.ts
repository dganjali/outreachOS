import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDomainAuth, type TxtResolver } from './dns-auth';

function resolver(map: Record<string, string[]>): TxtResolver {
  return async (host: string) => {
    if (!(host in map)) throw new Error('ENOTFOUND');
    return map[host].map((r) => [r]);
  };
}

describe('checkDomainAuth', () => {
  it('treats gmail.com as Google-authenticated without DNS', async () => {
    let called = false;
    const r = await checkDomainAuth('me@gmail.com', async () => {
      called = true;
      return [];
    });
    assert.equal(r.domainAuth, 'gmail');
    assert.equal(called, false);
  });

  it('reports ok when SPF + DMARC are present', async () => {
    const r = await checkDomainAuth(
      'me@acme.com',
      resolver({
        'acme.com': ['v=spf1 include:_spf.google.com ~all'],
        '_dmarc.acme.com': ['v=DMARC1; p=none'],
        'google._domainkey.acme.com': ['v=DKIM1; k=rsa; p=MIGf...'],
      }),
    );
    assert.equal(r.domainAuth, 'ok');
    assert.deepEqual([r.spf, r.dmarc, r.dkim], [true, true, true]);
  });

  it('reports partial with only SPF', async () => {
    const r = await checkDomainAuth('me@acme.com', resolver({ 'acme.com': ['v=spf1 ~all'] }));
    assert.equal(r.domainAuth, 'partial');
    assert.equal(r.spf, true);
    assert.equal(r.dmarc, false);
  });

  it('reports missing when nothing resolves', async () => {
    const r = await checkDomainAuth('me@acme.com', resolver({}));
    assert.equal(r.domainAuth, 'missing');
  });

  it('handles a malformed address', async () => {
    const r = await checkDomainAuth('not-an-email', resolver({}));
    assert.equal(r.domainAuth, 'missing');
  });
});
