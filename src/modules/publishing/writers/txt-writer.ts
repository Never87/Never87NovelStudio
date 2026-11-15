/**
 * TXT writer (P9 Batch A).
 *
 * Serialises a `RenderedDocument` into readable plain text. It consumes ONLY the
 * IR — it never queries a database and never re-applies preset rules (headings,
 * indentation and spacing were baked into the IR). Preset-driven *layout* that
 * is intrinsic to plain text (first-line indentation, blank lines between
 * paragraphs) is derived from the IR block types, not from the preset.
 *
 * Markdown inline syntax is stripped from paragraph text so the TXT output is
 * clean prose. Chinese and other Unicode text is preserved verbatim.
 */

import { markdownToPlainText } from '@/utils/manuscript-text';
import type { RenderedBlock, RenderedChapter, RenderedDocument, RenderedVolume } from '../types';

/** Number of blank lines emitted between blocks in TXT output. */
const BLOCK_GAP = 1;

function paragraphText(text: string): string {
  // Strip Markdown syntax; collapse internal blank lines to keep one paragraph.
  return markdownToPlainText(text).replace(/\n{2,}/g, '\n').trim();
}

/** Renders one block to its TXT lines. */
function blockLines(block: RenderedBlock): string[] {
  switch (block.type) {
    case 'heading': {
      const text = paragraphText(block.text);
      // Underline-ish emphasis for headings without Markdown: uppercase the line
      // and surround with blank spacing handled by the caller. Keep it readable.
      return text ? [text] : [];
    }
    case 'scene-break':
      return [block.text];
    case 'paragraph':
    default: {
      const text = paragraphText(block.text);
      return text ? [text] : [];
    }
  }
}

/** Joins block lines with the standard single blank line between blocks. */
function joinBlocks(lines: string[][]): string {
  const pieces = lines
    .map((block) => block.join('\n'))
    .filter((block) => block.trim().length > 0);
  return pieces.join('\n'.repeat(BLOCK_GAP + 1));
}

function renderChapter(chapter: RenderedChapter): string {
  return joinBlocks(chapter.blocks.map(blockLines));
}

function renderVolume(volume: RenderedVolume): string {
  const parts: string[] = [];
  if (volume.heading) {
    const headingLines = blockLines(volume.heading);
    if (headingLines.length > 0) parts.push(headingLines.join('\n'));
  }
  for (const chapter of volume.chapters) {
    const rendered = renderChapter(chapter);
    // Emit every chapter, even when empty, so no chapter silently disappears.
    parts.push(rendered);
  }
  return parts.filter((part) => part.trim().length > 0 || part === '').join('\n\n\n');
}

/**
 * Serialises a `RenderedDocument` to plain text.
 *
 * Returns a UTF-8 string with `\n` line endings and a single trailing newline.
 */
export function renderTxt(doc: RenderedDocument): string {
  const sections: string[] = [];
  if (doc.header) {
    const headerLines = blockLines(doc.header);
    if (headerLines.length > 0) sections.push(headerLines.join('\n\n'));
  }
  for (const volume of doc.volumes) {
    const rendered = renderVolume(volume);
    if (rendered.length > 0) sections.push(rendered);
  }
  const body = sections.join('\n\n\n').replace(/\n{3,}/g, '\n\n\n').trimEnd();
  return `${body}\n`;
}
