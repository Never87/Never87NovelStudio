/**
 * Manuscript text utilities: Markdown → plain text, word/character counts and
 * Markdown document conversion.
 *
 * These are pure functions shared by the Service (which persists the derived
 * counts), the editor UI (live counters) and import/export. Keeping one
 * implementation means the number on screen and the number in the database are
 * always produced by the same code.
 */

/**
 * Converts a Markdown document to plain text.
 *
 * Deliberately conservative: it strips syntax the editor can produce
 * (headings, emphasis, code fences, links, lists, blockquotes, horizontal
 * rules) and normalises block separators to single newlines. It is a counting
 * and preview helper, not an HTML renderer.
 */
export function markdownToPlainText(markdown: string): string {
  if (!markdown) return '';

  let text = markdown;

  // Fenced code blocks: keep the code, drop the fences.
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, '$1');
  // Indented code is treated as normal lines (still prose to the counter).

  // Inline code, then emphasis markers.
  text = text.replace(/`([^`\n]*)`/g, '$1');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/~~(.*?)~~/g, '$1');

  // Images before links: ![alt](src) -> alt ; [text](url) -> text
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // ATX headings and setext underlines.
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^(=+|-{3,})\s*$/gm, '');

  // Blockquote markers, list bullets and task boxes.
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, '');
  text = text.replace(/^\s{0,3}\[[ xX]\]\s+/gm, '');

  // Horizontal rules.
  text = text.replace(/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/gm, '');

  // Collapse trailing whitespace and runs of blank lines.
  text = text.replace(/[ \t]+$/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}

/**
 * Counts words in plain text.
 *
 * CJK characters count individually (a Chinese sentence has no spaces), while
 * Latin/Cyrillic/etc. runs count as one word each — so the count is meaningful
 * for both English and CJK manuscripts.
 */
export function countWords(plainText: string): number {
  if (!plainText) return 0;
  const cjk = plainText.match(
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g,
  );
  const latin = plainText.match(/[A-Za-z0-9\u00c0-\u024f\u0400-\u04ff'’\u2010-\u2015-]+/g);
  return (cjk?.length ?? 0) + (latin?.length ?? 0);
}

/** Characters excluding line breaks and surrounding whitespace. */
export function countCharacters(plainText: string): number {
  if (!plainText) return 0;
  return plainText.replace(/\s+/g, '').length;
}

/** Derived counters stored alongside every manuscript write. */
export interface TextStats {
  plainText: string;
  wordCount: number;
  characterCount: number;
}

/** Computes every derived field from Markdown in one pass. */
export function computeTextStats(markdown: string): TextStats {
  const plainText = markdownToPlainText(markdown ?? '');
  return {
    plainText,
    wordCount: countWords(plainText),
    characterCount: countCharacters(plainText),
  };
}

/** Short single-line excerpt for lists, ellipsised when truncated. */
export function excerpt(plainText: string, maxLength = 140): string {
  const flat = plainText.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLength) return flat;
  return `${flat.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Demotes every heading inside a chapter body to level 3.
 *
 * A chapter is stored as a leaf of a level-2 structure (chapter = `##`), so a
 * `#`/`##` heading written INSIDE a chapter would re-open a new chapter on the
 * next import — silently splitting the manuscript. Promoting them keeps each
 * chapter's internal structure intact while making export → import stable.
 */
export function normaliseChapterHeadings(content: string): string {
  if (!content) return content;
  return content
    .replace(/^(\s{0,3})#{1,2}(\s+\S)/gm, '$1###$2')
    // A closing setext underline would also be read as a heading; neutralise it.
    .replace(/^(\s{0,3})(=+|-{3,})\s*$/gm, '$1');
}

/** A chapter parsed out of an imported Markdown document. */
export interface ParsedMarkdownChapter {
  /** Heading text, or `''` when the document had no heading before the body. */
  title: string;
  /** Heading level the chapter was declared with (1 or 2; 0 when none). */
  level: number;
  /** Markdown body (heading removed). */
  content: string;
}

/**
 * Splits a Markdown document into chapters at level-1/level-2 headings.
 *
 * `#` and `##` both delimit chapters because exported manuscripts and
 * hand-written drafts use them interchangeably. Any text before the first
 * heading becomes an untitled leading chapter (kept, never discarded).
 */
export function splitMarkdownChapters(markdown: string): ParsedMarkdownChapter[] {
  const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const chapters: ParsedMarkdownChapter[] = [];
  let title = '';
  let level = 0;
  let buffer: string[] = [];
  let started = false;

  const flush = () => {
    const content = buffer.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (started || content.trim()) {
      chapters.push({ title: title.trim(), level, content });
    }
    buffer = [];
    started = false;
  };

  for (const line of lines) {
    const heading = /^#{1,2}\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      flush();
      level = heading[0].trimStart().startsWith('##') ? 2 : 1;
      title = heading[1];
      started = true;
      continue;
    }
    buffer.push(line);
  }
  flush();

  return chapters;
}

/** Escapes a title so it can be embedded in a Markdown heading. */
function headingSafe(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * Renders chapters back into a single Markdown document.
 * Round-trips with `splitMarkdownChapters` for headings that used `##`.
 */
export function chaptersToMarkdown(
  chapters: Array<{ title: string; content: string }>,
): string {
  return chapters
    .map((chapter) => {
      // Export applies the same heading normalisation as import, so the two are
      // exact inverses: a `#`/`##` written inside a chapter is demoted rather
      // than escaping as a new chapter on the next import.
      const body = normaliseChapterHeadings((chapter.content ?? '').trimEnd());
      const heading = chapter.title.trim() ? `## ${headingSafe(chapter.title)}` : '';
      if (!heading) return body;
      return body ? `${heading}\n\n${body}` : heading;
    })
    .filter(Boolean)
    .join('\n\n')
    .concat('\n');
}
