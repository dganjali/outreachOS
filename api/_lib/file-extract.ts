// File-to-text extraction utility.
//
// Switches on file extension / MIME type and returns the plain-text contents.
// Used by the extract-context agent (context dumps) and optionally by
// parse-resume to accept DOCX in addition to PDF.
//
// pdf-parse import trick: import the inner module directly to skip the
// self-test that fires when the package index is loaded (same pattern as
// api/agents/parse-resume.ts).
//
// @ts-expect-error — no types ship for the inner path
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { ocrTranscribe } from './llm';

/** Minimum character count before we consider the extraction a success. */
const MIN_CHARS = 50;

/**
 * Extract plain text from a file buffer.
 *
 * @param buf      Raw file bytes.
 * @param mime     MIME type as reported by the client (may be empty / null).
 * @param fileName Original file name — used to detect extension when MIME is empty.
 * @returns        The extracted text (trimmed).
 * @throws         `Error` with code `unsupported_file_type` or `text_empty`.
 */
export async function extractText(buf: Buffer, mime: string | null, fileName: string): Promise<string> {
  const ext = fileExt(fileName);
  const mimeNorm = (mime ?? '').toLowerCase().trim();

  let text = '';

  if (isPdf(mimeNorm, ext)) {
    const result = await pdfParse(buf);
    text = (result?.text ?? '').toString().trim();
    // Scanned/image-only PDFs have no embedded text layer — fall back to OCR.
    if (text.length < MIN_CHARS) {
      text = await ocrSafely(buf, mimeNorm || 'application/pdf', text);
    }
  } else if (isImage(mimeNorm, ext)) {
    // Images are pure pixels — OCR is the only path to text.
    text = await ocrSafely(buf, mimeNorm || imageMimeForExt(ext), '');
  } else if (isDocx(mimeNorm, ext)) {
    const result = await mammoth.extractRawText({ buffer: buf });
    text = (result?.value ?? '').trim();
  } else if (isTxtMd(mimeNorm, ext)) {
    text = buf.toString('utf8').trim();
  } else if (isRtf(mimeNorm, ext)) {
    text = stripRtf(buf.toString('utf8')).trim();
  } else {
    throw Object.assign(new Error(`Unsupported file type: ${mime ?? ext ?? 'unknown'}`), {
      code: 'unsupported_file_type',
    });
  }

  if (!text || text.length < MIN_CHARS) {
    throw Object.assign(
      new Error('No readable text found, even after OCR — is the file blank or corrupt?'),
      { code: 'text_empty' }
    );
  }

  return text;
}

/**
 * Run OCR, swallowing OCR-specific failures so we fall through to the normal
 * `text_empty` error with the original (possibly partial) text. `prev` is the
 * deterministic extraction so far — OCR only replaces it if it returns more.
 */
async function ocrSafely(buf: Buffer, mime: string, prev: string): Promise<string> {
  try {
    const ocr = await ocrTranscribe(buf, mime);
    return ocr.length > prev.length ? ocr : prev;
  } catch {
    return prev;
  }
}

// ---------------------------------------------------------------------------
// Type detection helpers
// ---------------------------------------------------------------------------

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

function isPdf(mime: string, ext: string): boolean {
  return mime === 'application/pdf' || ext === 'pdf';
}

function isDocx(mime: string, ext: string): boolean {
  return (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mime === 'application/msword' ||
    ext === 'docx' ||
    ext === 'doc'
  );
}

function isTxtMd(mime: string, ext: string): boolean {
  return (
    mime === 'text/plain' ||
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    ext === 'txt' ||
    ext === 'md' ||
    ext === 'markdown'
  );
}

function isRtf(mime: string, ext: string): boolean {
  return mime === 'text/rtf' || mime === 'application/rtf' || ext === 'rtf';
}

// Raster formats Gemini can OCR. Deliberately excludes GIF (low-text, animated)
// so it stays an unsupported type.
function isImage(mime: string, ext: string): boolean {
  return (
    mime === 'image/png' ||
    mime === 'image/jpeg' ||
    mime === 'image/webp' ||
    mime === 'image/heic' ||
    mime === 'image/heif' ||
    ext === 'png' ||
    ext === 'jpg' ||
    ext === 'jpeg' ||
    ext === 'webp' ||
    ext === 'heic' ||
    ext === 'heif'
  );
}

function imageMimeForExt(ext: string): string {
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    default:
      return 'image/png';
  }
}

// ---------------------------------------------------------------------------
// RTF stripper — no new dep. Handles pasted résumés well enough.
// ---------------------------------------------------------------------------

/**
 * Best-effort plain-text extraction from RTF. Walks the RTF byte-stream
 * character by character to handle arbitrary brace nesting, then cleans up
 * control words and hex escapes. Good enough for pasted résumés.
 */
export function stripRtf(rtf: string): string {
  // 1. Remove "destination" groups whose content should be discarded:
  //    \fonttbl, \colortbl, \stylesheet, \info, \pict, etc.
  //    These always appear as {\*\keyword ...} or {\keyword ...}.
  //    We use a stack-based pass to strip them.
  const skipKeywords = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'wmetafile',
    'blipuid', 'themedata', 'colorschememapping', 'latentstyles',
    'rsidtbl', 'generator', 'mmathPr',
  ]);

  // Walk character-by-character and build a text-only output string.
  let out = '';
  let i = 0;
  const n = rtf.length;
  // Stack tracks: should we suppress output for the current group depth?
  const suppress: boolean[] = [false];

  while (i < n) {
    const ch = rtf[i];

    if (ch === '{') {
      // Peek ahead: is this a destination group {\* ...} or {\keyword...}?
      let j = i + 1;
      // Skip optional \* marker
      if (rtf[j] === '\\' && rtf[j + 1] === '*') j += 2;
      // Skip whitespace
      while (j < n && rtf[j] === ' ') j++;
      // Read a control word if present
      if (rtf[j] === '\\') {
        let k = j + 1;
        while (k < n && /[a-zA-Z]/.test(rtf[k])) k++;
        const kw = rtf.slice(j + 1, k);
        suppress.push(skipKeywords.has(kw) || suppress[suppress.length - 1]);
      } else {
        suppress.push(suppress[suppress.length - 1]);
      }
      i++;
      continue;
    }

    if (ch === '}') {
      suppress.pop();
      i++;
      continue;
    }

    if (suppress[suppress.length - 1]) {
      i++;
      continue;
    }

    if (ch === '\\') {
      // Control word or symbol.
      i++;
      if (i >= n) break;
      const next = rtf[i];

      // Hex escape \'xx → latin-1 character.
      if (next === "'") {
        const hex = rtf.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 3;
          continue;
        }
        i++;
        continue;
      }

      // Special single-character escapes: \{ \} \\ → literal
      if (next === '{' || next === '}' || next === '\\') {
        out += next;
        i++;
        continue;
      }

      // Non-alphabetic single-char escapes (not hex, not {, }, \).
      if (!/[a-zA-Z]/.test(next)) {
        if (next === '~') out += ' '; // non-breaking space
        else if (next === '-') out += '­'; // soft hyphen
        else if (next === '_') out += '‑'; // non-breaking hyphen
        // Bare \newline / \return in RTF source = ignored whitespace.
        // Any other non-alpha (e.g. \%, \$) — emit it literally since
        // it's likely an accidental backslash in user-typed RTF content.
        else if (next !== '\n' && next !== '\r') out += next;
        i++;
        continue;
      }

      // Read the full control word.
      const kwStart = i;
      while (i < n && /[a-zA-Z]/.test(rtf[i])) i++;
      const kw = rtf.slice(kwStart, i);

      // Skip optional numeric parameter.
      while (i < n && /[-\d]/.test(rtf[i])) i++;
      // Skip a single trailing space (part of the control word).
      if (i < n && rtf[i] === ' ') i++;

      // Emit paragraph break for block-level paragraph controls.
      if (kw === 'par' || kw === 'pard' || kw === 'line' || kw === 'sect' || kw === 'page') {
        out += '\n';
      }
      // All other control words are silently discarded.
      continue;
    }

    // Plain character.
    out += ch;
    i++;
  }

  // Collapse excess whitespace.
  return out.replace(/\s+/g, ' ').trim();
}
