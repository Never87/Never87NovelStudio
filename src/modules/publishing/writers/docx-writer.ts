/**
 * DOCX writer (P9 Batch C).
 *
 * Serialises a `RenderedDocument` into a real Office Open XML `.docx` file using
 * the `docx` library (MIT). It consumes ONLY the IR produced by the Batch A
 * `FormattingPipeline` — it never reads the project or re-applies preset rules.
 *
 * Structure
 * ---------
 * - Document metadata (title / author / subject / description) is written to the
 *   OOXML core properties.
 * - The document header block (if the preset emits one) becomes a Title heading.
 * - Volume headings become Heading 1, chapter headings Heading 2 (matching the
 *   semantic levels the pipeline assigns); headings inside a chapter keep their
 *   (already demoted) level as Heading 2/3.
 * - Body paragraphs are real paragraphs with readable spacing; chapters are
 *   separated by page breaks so a chapter starts on a fresh page (except the
 *   first, whose volume heading already opens the page).
 * - Inline `**bold**` / `*italic*` / `` `code` `` are preserved as real text runs.
 *
 * Safety
 * ------
 * The writer NEVER injects manuscript text as raw XML markup. The `docx` library
 * builds structured OOXML from typed objects and all text is passed as
 * `TextRun` strings, so a `<script>` in prose becomes literal text, not markup.
 *
 * Chinese + Western font pairing: each run declares `ascii`/`hAnsi` (Western)
 * and `eastAsia` (Noto Sans SC) faces so Word applies the right font per script.
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  PageBreak,
} from 'docx';
import type { RenderedBlock, RenderedChapter, RenderedDocument, RenderedVolume } from '../types';
import { parseInlineRuns } from './inline-runs';
import type { ExportWriterOptions } from './writer-types';

/** Western serif used for Latin text in the body. */
const BODY_FONT_WEST = 'Georgia';
/** East-Asian body font (bundled Noto Sans SC). */
const BODY_FONT_EA = 'Noto Sans SC';
/** Monospace font for inline code runs. */
const CODE_FONT = 'Consolas';

/** Mixed-script font object for body runs (Latin + CJK resolved separately). */
const BODY_RUN_FONT = { ascii: BODY_FONT_WEST, hAnsi: BODY_FONT_WEST, eastAsia: BODY_FONT_EA };
/** Mixed-script font object for inline-code runs. */
const CODE_RUN_FONT = { ascii: CODE_FONT, hAnsi: CODE_FONT, eastAsia: BODY_FONT_EA };

/** Body font size in half-points (11pt = 22). */
const BODY_SIZE_HALF_PT = 22;
const H1_SIZE = 36; // 18pt
const H2_SIZE = 28; // 14pt
const H3_SIZE = 24; // 12pt
const TITLE_SIZE = 48; // 24pt

/** Maps an IR heading level to a docx HeadingLevel. */
function headingLevelFor(level: 1 | 2 | 3): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  switch (level) {
    case 1:
      return HeadingLevel.HEADING_1;
    case 3:
      return HeadingLevel.HEADING_3;
    case 2:
    default:
      return HeadingLevel.HEADING_2;
  }
}

function headingSizeFor(level: 1 | 2 | 3): number {
  if (level === 1) return H1_SIZE;
  if (level === 3) return H3_SIZE;
  return H2_SIZE;
}

/**
 * Builds the ordered `Paragraph`s for one IR block.
 *
 * Headings can carry multiple logical lines (e.g. the header's `title\n\nauthor`);
 * those are rendered as separate paragraphs so each stays on its own line.
 */
function blocksToParagraphs(block: RenderedBlock, opts: { pageBreakBefore?: boolean }): Paragraph[] {
  switch (block.type) {
    case 'heading': {
      const lines = block.text
        .split('\n\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const effectiveLines = lines.length > 0 ? lines : [''];
      return effectiveLines.map(
        (line, index) =>
          new Paragraph({
            heading: headingLevelFor(block.level),
            pageBreakBefore: index === 0 ? Boolean(opts.pageBreakBefore) : false,
            spacing: { before: 240, after: 120 },
            children: [
              new TextRun({
                text: line,
                bold: true,
                size: headingSizeFor(block.level),
                font: BODY_RUN_FONT,
              }),
            ],
          }),
      );
    }
    case 'scene-break':
      return [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 200 },
          children: [new TextRun({ text: block.text, italics: true, font: BODY_RUN_FONT })],
        }),
      ];
    case 'paragraph':
    default: {
      // Inline soft breaks become separate lines within one paragraph via breaks.
      const sourceLines = block.text.split('\n');
      const runs: TextRun[] = [];
      sourceLines.forEach((line, lineIndex) => {
        if (lineIndex > 0) runs.push(new TextRun({ break: 1 }));
        for (const run of parseInlineRuns(line)) {
          runs.push(
            new TextRun({
              text: run.text,
              bold: run.bold || undefined,
              italics: run.italic || undefined,
              font: run.code ? CODE_RUN_FONT : BODY_RUN_FONT,
              size: BODY_SIZE_HALF_PT,
            }),
          );
        }
      });
      if (runs.length === 0) {
        return [new Paragraph({ children: [], spacing: { after: 120 } })];
      }
      return [
        new Paragraph({
          spacing: { after: 120, line: 360 },
          children: runs,
        }),
      ];
    }
  }
}

/** Emits all paragraphs for a chapter, starting it on a new page when asked. */
function chapterToParagraphs(
  chapter: RenderedChapter,
  opts: { startOnNewPage: boolean },
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  chapter.blocks.forEach((block, index) => {
    const pageBreakBefore =
      opts.startOnNewPage && index === 0 && block.type === 'heading';
    paragraphs.push(...blocksToParagraphs(block, { pageBreakBefore }));
  });
  // A chapter with NO blocks at all still contributes a paragraph so it is never
  // visually lost (its title heading already handles the normal case).
  if (paragraphs.length === 0) {
    paragraphs.push(new Paragraph({ children: [new TextRun({ text: chapter.title, font: BODY_RUN_FONT })] }));
  }
  return paragraphs;
}

/** Emits all paragraphs for a volume (optional heading + its chapters). */
function volumeToParagraphs(volume: RenderedVolume): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  if (volume.heading) paragraphs.push(...blocksToParagraphs(volume.heading, {}));
  volume.chapters.forEach((chapter, index) => {
    // Start each chapter on a new page EXCEPT the first, whose preceding volume
    // heading (if present) already opens the page.
    const startOnNewPage = index > 0 || Boolean(volume.heading);
    paragraphs.push(...chapterToParagraphs(chapter, { startOnNewPage }));
  });
  return paragraphs;
}

/**
 * Serialises a `RenderedDocument` to `.docx` bytes.
 *
 * @param doc  The formatted intermediate representation.
 * @param options Metadata overrides (default to the IR metadata).
 * @returns The raw `.docx` bytes.
 */
export async function renderDocx(
  doc: RenderedDocument,
  options: ExportWriterOptions = {},
): Promise<Uint8Array> {
  const title = (options.title ?? doc.metadata.title ?? '').trim();
  const author = (options.author ?? doc.metadata.author ?? '').trim();

  const children: Paragraph[] = [];

  // Document header (title/author), if the preset emitted one.
  if (doc.header) {
    if (doc.header.type === 'heading') {
      const parts = doc.header.text.split('\n\n').map((s) => s.trim()).filter(Boolean);
      parts.forEach((part) => {
        children.push(
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [
              new TextRun({ text: part, bold: true, size: TITLE_SIZE, font: BODY_RUN_FONT }),
            ],
          }),
        );
      });
    } else {
      children.push(...blocksToParagraphs(doc.header, {}));
    }
    // A blank spacer after the header block.
    children.push(new Paragraph({ children: [] }));
  }

  for (const volume of doc.volumes) {
    children.push(...volumeToParagraphs(volume));
  }

  // Explicit closing page break so the file never ends mid-paragraph block.
  children.push(new Paragraph({ children: [new PageBreak()] }));

  const document = new Document({
    creator: author || 'Never87 Novel Studio',
    lastModifiedBy: author || 'Never87 Novel Studio',
    title: title || 'Untitled',
    subject: title || 'Manuscript',
    description: author ? `Manuscript by ${author}` : 'Manuscript export',
    styles: {
      default: {
        document: {
          run: { size: BODY_SIZE_HALF_PT, font: BODY_RUN_FONT },
        },
      },
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const arrayBuffer = await Packer.toArrayBuffer(document);
  return new Uint8Array(arrayBuffer);
}
