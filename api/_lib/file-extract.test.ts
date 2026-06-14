// Unit tests for api/_lib/file-extract.ts
// Run with: npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, stripRtf, isLowQualityText } from './file-extract.js';

// ---------------------------------------------------------------------------
// Pass-through: TXT and MD
// ---------------------------------------------------------------------------
describe('extractText — TXT pass-through', () => {
  it('returns UTF-8 string for text/plain MIME', async () => {
    const content = 'Built a 1,400-person developer conference in 2023 with 62% senior engineers.';
    const buf = Buffer.from(content, 'utf8');
    const result = await extractText(buf, 'text/plain', 'notes.txt');
    assert.equal(result, content.trim());
  });

  it('returns UTF-8 string when MIME is empty but extension is .txt', async () => {
    const content = 'Led engineering at Acme Corp. Raised $4M seed. 120k MAU product.';
    const buf = Buffer.from(content, 'utf8');
    const result = await extractText(buf, '', 'resume.txt');
    assert.equal(result, content.trim());
  });

  it('returns UTF-8 string for .md extension', async () => {
    const content = '# Bio\n\nFounding engineer at Foo, infra & ML. 3× YC alum.';
    const buf = Buffer.from(content, 'utf8');
    const result = await extractText(buf, null, 'bio.md');
    assert.ok(result.includes('Founding engineer'));
  });

  it('returns UTF-8 string for text/markdown MIME', async () => {
    const content = 'Senior engineer. Built payments infra for 10M users. Speaks at QCon.';
    const buf = Buffer.from(content, 'utf8');
    const result = await extractText(buf, 'text/markdown', 'bio.md');
    assert.equal(result, content.trim());
  });
});

// ---------------------------------------------------------------------------
// RTF strip
// ---------------------------------------------------------------------------
describe('extractText — RTF strip', () => {
  it('strips RTF control words and returns readable text', async () => {
    // Minimal RTF with a recognizable fact embedded.
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}` +
      String.raw`\pard\fs24 Backed by Vercel and Notion. 62\% senior engineers.\par}`;
    const buf = Buffer.from(rtf, 'utf8');
    const result = await extractText(buf, 'text/rtf', 'cv.rtf');
    assert.ok(result.includes('Vercel'), `Expected "Vercel" in: "${result}"`);
  });

  it('strips RTF by extension when MIME is empty', async () => {
    const rtf = String.raw`{\rtf1\ansi ` +
      String.raw`\pard Led engineering at TechCorp; raised \$4M seed round.\par}`;
    const buf = Buffer.from(rtf, 'utf8');
    const result = await extractText(buf, null, 'profile.rtf');
    assert.ok(result.includes('TechCorp'), `Expected "TechCorp" in: "${result}"`);
  });
});

// ---------------------------------------------------------------------------
// RTF unit helper
// ---------------------------------------------------------------------------
describe('stripRtf', () => {
  it('removes control words', () => {
    const rtf = String.raw`{\rtf1\ansi \pard Hello World\par}`;
    const out = stripRtf(rtf);
    assert.ok(out.includes('Hello World'), `Got: ${out}`);
  });

  it('unescapes hex sequences', () => {
    // \'e9 = é in latin-1
    const rtf = String.raw`{\rtf1 caf\'e9}`;
    const out = stripRtf(rtf);
    assert.ok(out.includes('é'), `Got: ${out}`);
  });
});

// ---------------------------------------------------------------------------
// isLowQualityText — the OCR-fallback trigger for PDFs
// ---------------------------------------------------------------------------
describe('isLowQualityText', () => {
  it('flags text shorter than the minimum', () => {
    assert.equal(isLowQualityText('too short'), true);
  });

  it('accepts a healthy résumé text layer', () => {
    const good =
      'Alex Chen — Senior Engineer at Acme. Built payments infrastructure for 10 million users. ' +
      'Raised a $4M seed round in 2023. Speaks at QCon and led a team of 8 engineers.';
    assert.equal(isLowQualityText(good), false);
  });

  it('flags mojibake from a broken font/CID encoding', () => {
    // The kind of soup pdf-parse emits for a PDF with no ToUnicode map — long
    // enough to pass the length check, but almost no readable characters.
    const garbage = '��'.repeat(40);
    assert.equal(isLowQualityText(garbage), true);
  });

  it('flags a thin layer of spaced single glyphs (no real words)', () => {
    const spaced = 'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z 1 2 3 4 5 6';
    assert.equal(isLowQualityText(spaced), true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported type — must throw with code unsupported_file_type
// ---------------------------------------------------------------------------
describe('extractText — unsupported type', () => {
  it('throws unsupported_file_type for unknown MIME with unknown extension', async () => {
    const buf = Buffer.from('GIF89a...', 'utf8');
    await assert.rejects(
      () => extractText(buf, 'image/gif', 'photo.gif'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('Unsupported') || (err as { code?: string }).code === 'unsupported_file_type',
          `Unexpected message: ${err.message}`
        );
        return true;
      }
    );
  });

  it('throws unsupported_file_type for .exe extension', async () => {
    const buf = Buffer.alloc(512);
    await assert.rejects(
      () => extractText(buf, null, 'program.exe'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Empty text — must throw with code text_empty
// ---------------------------------------------------------------------------
describe('extractText — empty text', () => {
  it('throws text_empty for a .txt file with only whitespace', async () => {
    const buf = Buffer.from('   \n\t  ', 'utf8');
    await assert.rejects(
      () => extractText(buf, 'text/plain', 'empty.txt'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        const code = (err as { code?: string }).code;
        assert.equal(code, 'text_empty', `Expected code text_empty, got: ${code}`);
        return true;
      }
    );
  });

  it('throws text_empty for a .txt file shorter than 50 chars', async () => {
    const buf = Buffer.from('hi', 'utf8');
    await assert.rejects(
      () => extractText(buf, 'text/plain', 'tiny.txt'),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});
