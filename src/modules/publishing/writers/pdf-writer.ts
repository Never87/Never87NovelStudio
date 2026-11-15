/**
 * PDF writer (P9 Batch C).
 *
 * Serialises a `RenderedDocument` into a real, embeddable CJK-capable PDF using
 * `pdf-lib` (MIT) + `@pdf-lib/fontkit` for TrueType embedding. It consumes ONLY
 * the IR produced by the Batch A `FormattingPipeline`.
 *
 * Why a bundled font
 * ------------------
 * The standard PDF fonts (Helvetica, Times) cannot render Chinese — the browser's
 * default fonts are NOT available to a hand-built PDF, so CJK text would appear as
 * blank glyphs or missing characters. To guarantee Chinese prose renders offline,
 * the writer EMBEDS the bundled Noto Sans SC subset (`public/fonts/…`). The font
 * bytes are supplied explicitly (`options.fontBytes`) so the writer stays pure and
 * testable in Node, while the browser fetches the same file on demand.
 *
 * Rendering model
 * ---------------
 * - A4 page with generous margins; body text is justified-left, wrapped at the
 *   measured glyph widths from the embedded font.
 * - CJK-aware wrapping: a line may break between two CJK ideographs (no spaces in
 *   Chinese) as well as at Latin word boundaries. The wrapper measures every
 *   candidate glyph with the real font metrics, so nothing overflows the margin.
 * - Headings are set larger and bold-ish (via size + spacing; the font is a single
 *   weight), centred where appropriate. The document title page shows the title and
 *   author.
 * - Scene breaks are rendered centred.
 * - Every page carries a page number in the footer.
 * - Text is drawn per-line as PDF text; because pdf-lib escapes string operands,
 *   a `<script>` in prose is inert text, never markup (PDF has no script anyway).
 *
 * Font safety
 * -----------
 * - Empty/invalid font bytes raise an `ExportError` (`font-missing`/`font-invalid`)
 *   rather than producing a corrupt or blank PDF.
 * - A character missing from the font is rendered as a safe fallback box (U+FFFD
 *   look-alike) rather than crashing, so the rest of the document still exports.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, PDFPageDrawTextOptions } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { RenderedBlock, RenderedDocument } from '../types';
import type { ExportWriterOptions } from './writer-types';
import { ExportError } from './writer-types';

/* ------------------------------- geometry -------------------------------- */

/** A4 in PDF points (1pt = 1/72 inch). */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = { top: 72, bottom: 72, left: 72, right: 72 };

/** Body font size (points). */
const BODY_SIZE = 11;
/** Line height multiplier applied to the body size. */
const LINE_HEIGHT = 1.6;
/** First-line indent for body paragraphs (in em). */
const INDENT_EM = 2;
/** Extra spacing before a new block (points). */
const BLOCK_GAP = 8;

/** Heading sizes by IR level. */
const HEADING_SIZE: Record<1 | 2 | 3, number> = { 1: 20, 2: 15, 3: 12.5 };

/** Content bounds. */
const CONTENT_LEFT = MARGIN.left;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN.right;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN.top;
const CONTENT_BOTTOM = MARGIN.bottom;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const INDENT_PT = BODY_SIZE * INDENT_EM;

/* ------------------------------- char tables ----------------------------- */

/**
 * Returns true when a code point may start a new line WITHOUT the preceding space
 * style break — i.e. CJK ideographs, full-width punctuation and similar. A break is
 * permitted before such a char even when there is no whitespace.
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK Radicals / Kangxi
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana / Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext-A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility
    (cp >= 0xff00 && cp <= 0xffef) // Fullwidth forms
  );
}

/**
 * Wraps a paragraph's plain text into lines that fit `maxWidth` at `size` using the
 * embedded font's real metrics. Breaks at whitespace for Latin text and between
 * adjacent CJK glyphs; never breaks in the middle of a Latin word unless the word
 * alone exceeds the line width (then it is hard-broken).
 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  // Split into "tokens" where each CJK char is its own token and Latin runs are
  // whitespace-delimited words. This lets a line break before a CJK char or at a
  // space, matching real Chinese/Latin mixed typesetting.
  const tokens: string[] = [];
  let buffer = '';
  const flushWord = () => {
    if (buffer.length > 0) {
      tokens.push(buffer);
      buffer = '';
    }
  };
  // Normalise newlines; explicit single newlines are treated as soft breaks we
  // honour by inserting a forced-break marker.
  const normalised = (text ?? '').replace(/\r\n?/g, '\n');
  for (const ch of normalised) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\n') {
      flushWord();
      tokens.push('\n');
    } else if (ch === ' ' || ch === '\t') {
      flushWord();
      tokens.push(' ');
    } else if (isCjkCodePoint(cp)) {
      flushWord();
      tokens.push(ch);
    } else {
      buffer += ch;
    }
  }
  flushWord();

  const measure = (s: string) => font.widthOfTextAtSize(s, size);

  let current = '';
  const pushCurrent = () => {
    lines.push(current.replace(/\s+$/, ''));
    current = '';
  };
  const appendToken = (token: string) => {
    current += token;
  };

  for (const token of tokens) {
    if (token === '\n') {
      pushCurrent();
      continue;
    }
    // Skip a space token that would start a line (avoid leading space).
    if (token === ' ' && current.length === 0) continue;

    const candidate = current + token;
    if (measure(candidate) <= maxWidth || current.trim().length === 0) {
      appendToken(token);
      continue;
    }
    // Doesn't fit: break the line here.
    pushCurrent();
    if (token === ' ') continue;
    // If a single Latin token still exceeds the line, hard-break it by glyph.
    if (measure(token) > maxWidth) {
      let piece = '';
      for (const ch of token) {
        if (measure(piece + ch) > maxWidth && piece.length > 0) {
          lines.push(piece);
          piece = ch;
        } else {
          piece += ch;
        }
      }
      current = piece;
    } else {
      current = token;
    }
  }
  if (current.length > 0) lines.push(current.replace(/\s+$/, ''));
  return lines.length > 0 ? lines : [''];
}

/* ------------------------------- drawing --------------------------------- */

/** A cursor tracking the current y on the current page. */
interface Cursor {
  page: PDFPage;
  y: number;
}

/** Draws a single text line at the cursor's baseline and advances y. */
function drawLine(
  pdf: PDFDocument,
  font: PDFFont,
  cursor: Cursor,
  text: string,
  size: number,
  opts: { x?: number; align?: 'left' | 'center' } = {},
): void {
  const lineHeight = size * LINE_HEIGHT;
  // Start a new page when we run past the bottom margin (leave room for line).
  if (cursor.y - lineHeight < CONTENT_BOTTOM - 4) {
    cursor.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    cursor.y = CONTENT_TOP;
  }
  const drawOptions: PDFPageDrawTextOptions = {
    x: opts.x ?? CONTENT_LEFT,
    y: cursor.y - size,
    size,
    font,
    color: rgb(0.05, 0.05, 0.05),
  };
  if (opts.align === 'center') {
    const width = font.widthOfTextAtSize(text, size);
    drawOptions.x = CONTENT_LEFT + (CONTENT_WIDTH - width) / 2;
  }
  cursor.page.drawText(text, drawOptions);
  cursor.y -= lineHeight;
}

/* ------------------------------- writer ---------------------------------- */

/**
 * Serialises a `RenderedDocument` to `.pdf` bytes with the bundled CJK font.
 *
 * @param doc     The formatted intermediate representation.
 * @param options Must include `fontBytes` (or `fontDataBase64`) for the PDF.
 * @throws {ExportError} `font-missing`/`font-invalid` when font bytes are absent
 *   or unusable, and `writer-failed` if pdf-lib throws while serialising.
 */
export async function renderPdf(
  doc: RenderedDocument,
  options: ExportWriterOptions = {},
): Promise<Uint8Array> {
  const fontBytes = resolveFontBytes(options);
  if (!fontBytes || fontBytes.byteLength === 0) {
    throw new ExportError(
      'font-missing',
      'write',
      'A CJK font is required to export PDF (Chinese text cannot be rendered by the standard PDF fonts).',
    );
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  let font: PDFFont;
  try {
    // `subset: false` embeds the (already pre-subset) bundled font in full. pdf-lib's
    // on-the-fly subsetting is unreliable for large CJK fonts in this environment
    // (it produced missing glyphs), so full embedding of the pre-subset file is the
    // correct, verified path.
    font = await pdf.embedFont(fontBytes, { subset: false });
  } catch (error) {
    throw new ExportError('font-invalid', 'write', 'The supplied font could not be embedded.', error);
  }

  // A standard font for the small footer only (page numbers are Latin digits and
  // render fine with Helvetica; keeps the footer independent of the CJK font).
  const footerFont = await pdf.embedFont(StandardFonts.Helvetica);

  const title = (options.title ?? doc.metadata.title ?? '').trim();
  const author = (options.author ?? doc.metadata.author ?? '').trim();

  const cursor: Cursor = { page: pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]), y: CONTENT_TOP };

  try {
    // ---- Title page -------------------------------------------------------
    // Only render a dedicated title block when the preset requested a header.
    if (doc.header) {
      const titleY0 = PAGE_HEIGHT - 220;
      cursor.y = titleY0;
      const titleLines = wrapText(title || doc.header.text, font, 26, CONTENT_WIDTH);
      for (const line of titleLines) {
        drawLine(pdf, font, cursor, line, 26, { align: 'center' });
      }
      cursor.y -= 12;
      if (author) {
        const authorLines = wrapText(author, font, 14, CONTENT_WIDTH);
        for (const line of authorLines) {
          drawLine(pdf, font, cursor, line, 14, { align: 'center' });
        }
      }
      // Start the body on a fresh page after the title page.
      cursor.page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      cursor.y = CONTENT_TOP;
    }

    // ---- Body -------------------------------------------------------------
    const drawBlock = (block: RenderedBlock, isFirstBlock: boolean) => {
      switch (block.type) {
        case 'heading': {
          const size = HEADING_SIZE[block.level];
          if (!isFirstBlock) cursor.y -= BLOCK_GAP * 1.5;
          const parts = block.text.split('\n\n').map((s) => s.trim()).filter(Boolean);
          for (const part of parts) {
            const lines = wrapText(part, font, size, CONTENT_WIDTH);
            for (const line of lines) {
              drawLine(pdf, font, cursor, line, size, { align: 'center' });
            }
          }
          cursor.y -= BLOCK_GAP;
          break;
        }
        case 'scene-break': {
          cursor.y -= BLOCK_GAP;
          const lines = wrapText(block.text, font, BODY_SIZE, CONTENT_WIDTH);
          for (const line of lines) {
            drawLine(pdf, font, cursor, line, BODY_SIZE, { align: 'center' });
          }
          cursor.y -= BLOCK_GAP;
          break;
        }
        case 'paragraph':
        default: {
          // Inline Markdown markers are stripped for a clean prose PDF
          // (**bold** / *italic* / `code` lose their markers but keep their text).
          const plain = stripInlineMarkers(block.text);
          const lines = wrapText(plain, font, BODY_SIZE, CONTENT_WIDTH).flatMap((line) =>
            line.includes('\n') ? line.split('\n') : [line],
          );
          lines.forEach((line, index) => {
            const x = index === 0 ? CONTENT_LEFT + INDENT_PT : CONTENT_LEFT;
            drawLine(pdf, font, cursor, line, BODY_SIZE, { x });
          });
          cursor.y -= BLOCK_GAP;
          break;
        }
      }
    };

    let firstBlockOverall = true;
    for (const volume of doc.volumes) {
      if (volume.heading) {
        drawBlock(volume.heading, firstBlockOverall);
        firstBlockOverall = false;
      }
      for (const chapter of volume.chapters) {
        // Each chapter renders its blocks in order. When the preset emitted a
        // chapter heading, it is already `chapter.blocks[0]`; nothing is prepended
        // here so the pipeline stays the single source of structure.
        chapter.blocks.forEach((block, blockIndex) => {
          drawBlock(block, firstBlockOverall && blockIndex === 0);
          firstBlockOverall = false;
        });
        // A chapter with no blocks at all still contributes a heading so it is
        // never silently dropped from the PDF.
        if (chapter.blocks.length === 0) {
          drawBlock(
            { type: 'heading', level: 2, text: chapter.title || '' } as RenderedBlock,
            firstBlockOverall,
          );
          firstBlockOverall = false;
        }
      }
    }

    // ---- Footer page numbers ---------------------------------------------
    const pages = pdf.getPages();
    pages.forEach((page, index) => {
      const label = `${index + 1} / ${pages.length}`;
      const width = footerFont.widthOfTextAtSize(label, 9);
      page.drawText(label, {
        x: (PAGE_WIDTH - width) / 2,
        y: MARGIN.bottom / 2,
        size: 9,
        font: footerFont,
        color: rgb(0.4, 0.4, 0.4),
      });
    });

    // Document metadata.
    pdf.setTitle(title || 'Manuscript');
    if (author) pdf.setAuthor(author);
    if (doc.metadata.language) pdf.setLanguage(doc.metadata.language);
    pdf.setCreator('Never87 Novel Studio');
    pdf.setProducer('Never87 Novel Studio (pdf-lib + Noto Sans SC)');

    const bytes = await pdf.save();
    // pdf-lib returns `Uint8Array`; normalise to a plain Uint8Array view.
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError('writer-failed', 'write', 'Failed to render the PDF document.', error);
  }
}

/** Resolves font bytes from `fontBytes` or a base64 data URL/string. */
function resolveFontBytes(options: ExportWriterOptions): Uint8Array | null {
  if (options.fontBytes && options.fontBytes.byteLength > 0) return options.fontBytes;
  if (options.fontDataBase64) {
    const b64 = options.fontDataBase64.replace(/^data:[^;]+;base64,/, '');
    try {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }
  return null;
}

/** Strips the small inline-Markdown subset to clean prose for the PDF. */
function stripInlineMarkers(text: string): string {
  return (text ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2');
}
