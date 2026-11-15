/**
 * Markdown writer (P9 Batch A).
 *
 * Serialises a `RenderedDocument` into deterministic Markdown. It consumes ONLY
 * the IR — headings, volume inclusion and paragraph structure were decided by the
 * preset in the pipeline; this writer just maps IR blocks to Markdown syntax.
 *
 * Hierarchy discipline
 * --------------------
 * The import/export layer treats a level-1/`#` or level-2/`##` heading as a
 * CHAPTER boundary (`splitMarkdownChapters`). To keep export → import stable:
 *
 *  - The document header (if any) is emitted as `#` (title level).
 *  - Volume headings are emitted as `##`.
 *  - Chapter headings are emitted as `##` too (a chapter is a level-2 node),
 *    matching `ManuscriptTransferService` which exports chapters as `##`.
 *  - Headings INSIDE a chapter body were already demoted by the pipeline to
 *    level >= 3, so they stay within the chapter on re-import.
 *
 * Inline Markdown (emphasis, links, code) in paragraph text is preserved
 * verbatim — the manuscript is not casually stripped.
 */

import type { RenderedBlock, RenderedChapter, RenderedDocument, RenderedVolume } from '../types';

/** Repeated blank line separators between top-level parts. */
const PART_GAP = '\n\n';

function blockToMarkdown(block: RenderedBlock): string {
  switch (block.type) {
    case 'heading': {
      const hashes = '#'.repeat(block.level);
      return `${hashes} ${block.text}`.trim();
    }
    case 'scene-break':
      return block.text;
    case 'paragraph':
    default:
      return block.text.trim();
  }
}

function blocksToMarkdown(blocks: readonly RenderedBlock[]): string {
  return blocks
    .map(blockToMarkdown)
    .filter((piece) => piece.length > 0)
    .join(PART_GAP);
}

function chapterToMarkdown(chapter: RenderedChapter): string {
  // Even an empty chapter keeps its heading block (if present); if it has no
  // blocks, still emit the chapter title as a level-2 heading so the chapter is
  // never lost on round-trip.
  const body = blocksToMarkdown(chapter.blocks);
  if (body.length > 0) return body;
  return `## ${chapter.title}`.trim();
}

function volumeToMarkdown(volume: RenderedVolume): string {
  const parts: string[] = [];
  if (volume.heading) {
    const heading = blockToMarkdown(volume.heading);
    if (heading.length > 0) parts.push(heading);
  }
  for (const chapter of volume.chapters) {
    parts.push(chapterToMarkdown(chapter));
  }
  return parts.filter((part) => part.length > 0).join(PART_GAP);
}

/**
 * Serialises a `RenderedDocument` to Markdown.
 *
 * Returns a UTF-8 string with `\n` line endings and a single trailing newline.
 */
export function renderMarkdown(doc: RenderedDocument): string {
  const parts: string[] = [];
  if (doc.header) {
    const header = blockToMarkdown(doc.header);
    if (header.length > 0) parts.push(header);
  }
  for (const volume of doc.volumes) {
    const rendered = volumeToMarkdown(volume);
    if (rendered.length > 0) parts.push(rendered);
  }
  const body = parts.join(PART_GAP).trim();
  return body.length > 0 ? `${body}\n` : '';
}
