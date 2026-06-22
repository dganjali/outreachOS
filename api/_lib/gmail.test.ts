import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMimeMultipart } from './gmail';

const base = {
  fromEmail: 'me@acme.co',
  toEmail: 'them@target.com',
  subject: 'Hello there',
  body: 'Line one\nLine two',
};

describe('buildMimeMultipart', () => {
  it('produces a multipart/mixed message with a text part and an attachment', () => {
    const raw = buildMimeMultipart({
      ...base,
      attachments: [{ filename: 'resume.pdf', mimeType: 'application/pdf', content: Buffer.from('hello pdf') }],
    });
    const boundaryMatch = raw.match(/boundary="([^"]+)"/);
    assert.ok(boundaryMatch, 'declares a boundary');
    const boundary = boundaryMatch![1];

    assert.match(raw, /Content-Type: multipart\/mixed/);
    assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);
    assert.match(raw, /Content-Type: application\/pdf; name="resume.pdf"/);
    assert.match(raw, /Content-Disposition: attachment; filename="resume.pdf"/);
    assert.match(raw, /Content-Transfer-Encoding: base64/);
    // The attachment bytes are base64-encoded.
    assert.ok(raw.includes(Buffer.from('hello pdf').toString('base64')));
    // Closes the multipart correctly.
    assert.ok(raw.trimEnd().endsWith(`--${boundary}--`));
    // CRLF line endings throughout.
    assert.match(raw, /\r\n/);
  });

  it('sanitizes a filename that tries to inject a header or break the param', () => {
    const raw = buildMimeMultipart({
      ...base,
      attachments: [
        {
          filename: 'evil"\r\nBcc: attacker@x.com\r\n.pdf',
          mimeType: 'application/pdf',
          content: Buffer.from('x'),
        },
      ],
    });
    // No raw CR/LF survives inside the filename, so no smuggled Bcc header.
    assert.ok(!/filename="[^"]*\r/.test(raw));
    assert.ok(!raw.includes('Bcc: attacker@x.com'));
    assert.ok(!raw.includes('evil"'), 'quote stripped from filename');
  });

  it('wraps long base64 attachment content at 76 chars', () => {
    const raw = buildMimeMultipart({
      ...base,
      attachments: [{ filename: 'big.bin', mimeType: 'application/octet-stream', content: Buffer.alloc(500, 0x41) }],
    });
    // Find the base64 block (after the attachment headers) and assert no line is
    // longer than 76 chars.
    const b64Lines = raw
      .split('\r\n')
      .filter((l) => /^[A-Za-z0-9+/=]+$/.test(l) && l.length > 20);
    assert.ok(b64Lines.length > 1, 'content spans multiple wrapped lines');
    assert.ok(b64Lines.every((l) => l.length <= 76));
  });

  it('falls back to octet-stream when no mime type is given', () => {
    const raw = buildMimeMultipart({
      ...base,
      attachments: [{ filename: 'x', mimeType: '', content: Buffer.from('y') }],
    });
    assert.match(raw, /Content-Type: application\/octet-stream/);
  });
});
