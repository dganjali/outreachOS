import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintContent } from './content-guard';

const clean = {
  subject: 'Quick question about your backend hiring',
  body: 'Hi Martin,\n\nI saw Acme is scaling the platform team and wanted to ask how you are approaching senior backend hires this quarter. Happy to share what worked for us.\n\nBest,\nDan',
};

function codes(r: ReturnType<typeof lintContent>) {
  return r.issues.map((i) => i.code);
}

describe('lintContent', () => {
  it('passes a clean, personal email', () => {
    const r = lintContent(clean);
    assert.equal(r.severity, 'ok');
    assert.equal(r.issues.length, 0);
  });

  it('blocks empty subject or body', () => {
    assert.equal(lintContent({ subject: '', body: clean.body }).severity, 'block');
    assert.equal(lintContent({ subject: clean.subject, body: '' }).severity, 'block');
  });

  it('blocks unfilled merge tags in several syntaxes', () => {
    for (const body of ['Hi {{first_name}},', 'Hi {first_name},', 'Hi [[company]],', 'Hi <first name>,', 'Hi FIRSTNAME,']) {
      const r = lintContent({ subject: 'hello there friend', body: `${body}\n${clean.body}` });
      assert.equal(r.severity, 'block', `expected block for: ${body}`);
      assert.ok(codes(r).includes('unfilled_merge_tag'));
    }
  });

  it('blocks an ALL CAPS subject', () => {
    const r = lintContent({ subject: 'LIMITED OFFER INSIDE', body: clean.body });
    assert.equal(r.severity, 'block');
    assert.ok(codes(r).includes('allcaps_subject'));
  });

  it('blocks link shorteners and too many links', () => {
    const short = lintContent({ subject: clean.subject, body: 'See http://bit.ly/abc for details about our work together here.' });
    assert.ok(codes(short).includes('link_shortener'));
    const many = lintContent({
      subject: clean.subject,
      body: 'links: https://a.com https://b.com https://c.com https://d.com https://e.com all here',
    });
    assert.ok(codes(many).includes('too_many_links'));
  });

  it('blocks high spam-phrase density, warns on moderate', () => {
    const high = lintContent({
      subject: 'Act now',
      body: 'ACT NOW! This is a 100% free risk-free limited time offer, click here to buy now and win cash bonus.',
    });
    assert.equal(high.severity, 'block');

    const moderate = lintContent({
      subject: 'A quick note',
      body: 'We guarantee results and this is a limited time chance to chat. No pressure at all, let me know.',
    });
    assert.equal(moderate.severity, 'warn');
    assert.ok(codes(moderate).includes('spam_phrases'));
  });

  it('warns (not blocks) on softer signals', () => {
    const r = lintContent({ subject: clean.subject, body: 'Hey!!! WHATS UP THIS IS SUPER URGENT OKAY' });
    assert.equal(r.severity, 'warn');
    assert.ok(r.issues.every((i) => i.severity === 'warn'));
  });

  it('warns on a faked Re: subject', () => {
    const r = lintContent({ subject: 'Re: our chat', body: clean.body });
    assert.ok(codes(r).includes('fake_reply_subject'));
  });
});
