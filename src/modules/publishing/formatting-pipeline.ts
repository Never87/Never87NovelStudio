/**
 * Formatting pipeline (P9 Batch A).
 *
 * Converts a `BookAssemblyModel` + a `PublishingPreset` into a deterministic,
 * format-neutral `RenderedDocument`. Preset rules are applied EXACTLY ONCE here;
 * no writer re-applies them. The pipeline is pure (no React, no browser, no
 * downloads) and never mutates its inputs.
 *
 * Markdown handling
 * -----------------
 * Chapter prose is stored as Markdown (the editor's source of truth). The
 * pipeline preserves it rather than discarding it:
 *
 *  - The manuscript is split into BLOCKS (paragraphs, and explicit scene-break
 *    blocks) at blank lines.
 *  - Heading syntax INSIDE a chapter body is demoted (via the same rule the
 *    import/export layer uses, `normaliseChapterHeadings`) so that a `#`/`##`
 *    written in prose cannot re-open a chapter on a later round-trip. The demoted
 *    text is KEPT, never dropped — a heading line becomes a paragraph block whose
 *    level is recorded so writers that support headings (Markdown) can honour it.
 *  - Inline Markdown (emphasis, links, code) is preserved verbatim in paragraph
 *    text. Each writer decides how to represent it for its target format
 *    (Markdown keeps it; TXT strips it; HTML renders a safe subset).
 *
 * Explicit scene breaks are recognised only when a paragraph consists ENTIRELY of
 * a recognised break marker (e.g. `***`, `* * *`, `---`); they are rendered with
 * the preset's `sceneBreak` representation.
 */

import { normaliseChapterHeadings } from '@/utils/manuscript-text';
import type {
  AssemblyChapter,
  BookAssemblyModel,
  PublishingPreset,
  RenderedBlock,
  RenderedChapter,
  RenderedDocument,
  RenderedVolume,
} from './types';

/** A recognised scene-break marker line (whole-line match). */
const SCENE_BREAK_LINE = /^\s*(?:[*＊]\s*){3,}\s*$|^\s*(?:-\s*){3,}\s*$|^\s*(?:_\s*){3,}\s*$/;

/** Matches an ATX heading line and captures level + text. */
const ATX_HEADING = /^(#{1,6})\s+(.*\S)\s*$/;

/** Whether a paragraph is an explicit scene-break marker. */
function isSceneBreakLine(line: string): boolean {
  return SCENE_BREAK_LINE.test(line);
}

/** Splits Markdown into blank-line-separated paragraphs, preserving order. */
function splitParagraphs(markdown: string): string[] {
  const normalised = (markdown ?? '').replace(/\r\n?/g, '\n');
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length > 0) {
      const text = buffer.join('\n').replace(/\s+$/, '');
      if (text.trim().length > 0) paragraphs.push(text);
      buffer = [];
    }
  };
  for (const line of normalised.split('\n')) {
    if (line.trim() === '') {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return paragraphs;
}

/**
 * Converts one chapter's Markdown body into ordered blocks.
 *
 * Internal headings are demoted with `normaliseChapterHeadings` so they cannot
 * split a chapter on re-import, then emitted as `heading` blocks carrying their
 * (demoted) level. Everything else is a paragraph; explicit scene-break markers
 * become `scene-break` blocks.
 */
function chapterBodyBlocks(content: string, preset: PublishingPreset): RenderedBlock[] {
  const blocks: RenderedBlock[] = [];
  if (!content || content.trim() === '') return blocks;

  const demoted = normaliseChapterHeadings(content);
  for (const paragraph of splitParagraphs(demoted)) {
    const lines = paragraph.split('\n');
    // A paragraph made purely of a scene-break marker is a scene break.
    if (lines.length === 1 && isSceneBreakLine(lines[0])) {
      blocks.push({ type: 'scene-break', text: preset.sceneBreak });
      continue;
    }
    // A single-line ATX heading becomes a heading block (level clamped to 1..3).
    if (lines.length === 1) {
      const heading = ATX_HEADING.exec(lines[0]);
      if (heading) {
        const level = Math.min(3, Math.max(1, heading[1].length)) as 1 | 2 | 3;
        blocks.push({ type: 'heading', level, text: heading[2].trim() });
        continue;
      }
    }
    blocks.push({ type: 'paragraph', text: paragraph.trim() });
  }
  return blocks;
}

/** Formats a volume heading text from the preset template. */
function formatVolumeHeading(preset: PublishingPreset, index: number, title: string): string {
  return preset.volumeHeadingTemplate
    .replace(/\{index\}/g, String(index))
    .replace(/\{title\}/g, title)
    .trim();
}

/** Formats a chapter heading text from the preset template + style. */
function formatChapterHeading(
  preset: PublishingPreset,
  index: number,
  title: string,
): string | null {
  if (preset.chapterHeadingStyle === 'none') return null;
  const num =
    preset.chapterHeadingStyle === 'number-padded'
      ? String(index).padStart(2, '0')
      : String(index);
  return preset.chapterHeadingTemplate
    .replace(/\{index\}/g, num)
    .replace(/\{title\}/g, title)
    .trim();
}

/** Renders a single chapter into its `RenderedChapter`. */
function renderChapter(
  preset: PublishingPreset,
  chapter: AssemblyChapter,
  index: number,
): RenderedChapter {
  const blocks: RenderedBlock[] = [];
  const headingText = formatChapterHeading(preset, index, chapter.title);
  if (headingText !== null && headingText !== '') {
    // Chapters are LEVEL-2 semantic nodes (they nest under a volume / the book
    // title). The Markdown writer maps this to `##`, matching the import/export
    // layer's chapter boundary so export → import round-trips; HTML maps it to
    // <h2>; TXT ignores the level.
    blocks.push({ type: 'heading', level: 2, text: headingText });
  }
  blocks.push(...chapterBodyBlocks(chapter.content, preset));
  return { id: chapter.id, title: chapter.title, blocks };
}

/** Builds the document header block according to the metadata policy. */
function renderHeader(preset: PublishingPreset, model: BookAssemblyModel): RenderedBlock | null {
  const { title, author } = model.project;
  if (preset.metadata === 'none') return null;
  if (preset.metadata === 'title-and-author' && author && author.trim() !== '') {
    return { type: 'heading', level: 1, text: `${title}\n\n${author}`.trim() };
  }
  return { type: 'heading', level: 1, text: title };
}

/**
 * The shared formatting pipeline.
 *
 * `render(model, preset)` is deterministic for equal inputs and never mutates
 * the model or the preset.
 */
export class FormattingPipeline {
  /**
   * Applies `preset` to `model` exactly once, producing a `RenderedDocument`.
   *
   * Chapters are numbered GLOBALLY across the book (1..N) in canonical order,
   * so chapter numbers stay stable regardless of how volumes are grouped. This
   * mirrors how most serialised novels number chapters.
   */
  render(model: BookAssemblyModel, preset: PublishingPreset): RenderedDocument {
    const volumes: RenderedVolume[] = [];
    const chapterBlocks: RenderedChapter[][] = [];
    let globalChapterIndex = 0;

    model.volumes.forEach((volume, volumeIndex) => {
      const heading: RenderedBlock | null = preset.includeVolumeHeadings
        ? { type: 'heading', level: 1, text: formatVolumeHeading(preset, volumeIndex + 1, volume.title) }
        : null;

      const chapters: RenderedChapter[] = volume.chapters.map((chapter) => {
        globalChapterIndex += 1;
        return renderChapter(preset, chapter, globalChapterIndex);
      });
      chapterBlocks.push(chapters);

      volumes.push({ id: volume.id, title: volume.title, heading, chapters });
    });

    return {
      metadata: {
        title: model.project.title,
        author: model.project.author,
        language: model.project.language,
      },
      presetId: preset.id,
      header: renderHeader(preset, model),
      volumes,
    };
  }
}

/** Convenience: render with a one-off pipeline instance. */
export function renderDocument(
  model: BookAssemblyModel,
  preset: PublishingPreset,
): RenderedDocument {
  return new FormattingPipeline().render(model, preset);
}
