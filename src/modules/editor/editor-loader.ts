/**
 * Story Editor — Markdown → HTML loader.
 *
 * The manuscript is stored as Markdown, but a TipTap ProseMirror editor is NOT a
 * Markdown editor: `setContent(string)` treats its input as **HTML** (via
 * DOMParser). Passing raw Markdown therefore renders the syntax literally — a
 * heading shows its `##`, `**bold**` stays asterisks, and `![alt](src)` never
 * becomes an image. `getMarkdown` (the serialiser) assumed the editor content
 * was already structural, so the two never met.
 *
 * This module closes that loop. It parses the Markdown SUBSET that `getMarkdown`
 * emits (and sensible extras a user might type or paste) into the HTML the
 * editor's schema understands, so:
 *
 *     stored Markdown → markdownToEditorHtml → TipTap → getMarkdown → Markdown
 *
 * round-trips faithfully. It is intentionally a small, dependency-free parser
 * covering exactly what the editor models:
 *
 *   blocks : paragraphs, `#`–`######` headings, blockquotes, `-`/`*` bullet lists,
 *            `1.` ordered lists, ``` fenced code blocks, `---` thematic breaks;
 *   inline : `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strike~~`,
 *            `` `code` ``, `[text](url)` links, `![alt](src)` images.
 *
 * DESIGN SAFETY
 * -------------
 * Because it produces HTML that is then parsed into ProseMirror, NO raw user
 * HTML is ever passed through: the only tags emitted are the fixed set below,
 * and every piece of text and attribute value is HTML-escaped. A `<script>` in
 * the prose therefore becomes literal, escaped text — never markup.
 *
 * Markdown syntax that the editor does not model (tables, footnotes, etc.) is
 * left as plain text paragraphs rather than dropped, so nothing is lost.
 */

import { escapeHtml } from './editor-html-utils';

/* -------------------------------------------------------------------------- */
/* Inline parsing                                                             */
/* -------------------------------------------------------------------------- */

/** Matches `![alt](src)` or `[text](url)` (images first). */
const INLINE_LINK_OR_IMAGE = /(!?)\[(.*?)\]\((.*?)\)/;

/** Escapes text for HTML and turns hard line breaks into `<br>`. */
function escapeText(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * Applies inline Markdown mark-up to already-safe text fragments.
 *
 * We tokenise on the FIRST recognised construct, recursively format the text
 * before it, emit the construct, and continue after it. This keeps nesting
 * predictable (e.g. bold wrapping a link) without a full inline grammar.
 */
function formatInline(input: string): string {
  let output = '';
  let rest = input;

  while (rest.length > 0) {
    // Earliest of: a link/image, a code span, a strong/em/strike marker.
    const candidates: Array<{ index: number; length: number; render: () => string }> = [];

    const linkMatch = INLINE_LINK_OR_IMAGE.exec(rest);
    if (linkMatch && linkMatch.index >= 0) {
      const isImage = linkMatch[1] === '!';
      const label = linkMatch[2];
      const href = linkMatch[3];
      candidates.push({
        index: linkMatch.index,
        length: linkMatch[0].length,
        render: () =>
          isImage
            ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(label)}">`
            : `<a href="${escapeHtml(href)}">${formatInline(label || href)}</a>`,
      });
    }

    const codeMatch = /`([^`]+)`/.exec(rest);
    if (codeMatch && codeMatch.index >= 0) {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        render: () => `<code>${escapeHtml(codeMatch[1])}</code>`,
      });
    }

    // Bold/italic/strike markers.
    for (const { pattern, tag } of [
      { pattern: /\*\*([^*]+)\*\*/, tag: 'strong' },
      { pattern: /__([^_]+)__/, tag: 'strong' },
      { pattern: /~~([^~]+)~~/, tag: 's' },
      { pattern: /\*([^*]+)\*/, tag: 'em' },
      { pattern: /_([^_]+)_/, tag: 'em' },
    ] as const) {
      const match = pattern.exec(rest);
      if (match && match.index >= 0) {
        candidates.push({
          index: match.index,
          length: match[0].length,
          render: () => `<${tag}>${formatInline(match[1])}</${tag}>`,
        });
      }
    }

    if (candidates.length === 0) {
      output += escapeText(rest);
      break;
    }

    // Earliest start wins; on a tie prefer the longer construct (e.g. `**` over `*`).
    candidates.sort((a, b) => a.index - b.index || b.length - a.length);
    const chosen = candidates[0];
    output += escapeText(rest.slice(0, chosen.index));
    output += chosen.render();
    rest = rest.slice(chosen.index + chosen.length);
  }

  return output;
}

/* -------------------------------------------------------------------------- */
/* Block parsing                                                             */
/* -------------------------------------------------------------------------- */

const ATX_HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE = /^```(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^\s*[-*+]\s+(.*\S)\s*$/;
const ORDERED = /^\s*\d+[.)]\s+(.*\S)\s*$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;
/** A paragraph made only of a bare image becomes a block image. */
const STANDALONE_IMAGE = /^\s*(!\[.*?\]\(.*?\))\s*$/;

/**
 * Converts a Markdown document to HTML matching the editor's schema.
 *
 * All output tags are a FIXED set (p, h1–h6, blockquote, ul, ol, li, pre, code,
 * hr, a, strong, em, s, br, img); no user HTML is ever emitted.
 */
export function markdownToEditorHtml(markdown: string): string {
  const normalised = (markdown ?? '').replace(/\r\n?/g, '\n');
  if (normalised.trim() === '') return '<p></p>';

  const lines = normalised.split('\n');
  const html: string[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]) => {
    if (buffer.length === 0) return;
    html.push(`<p>${formatInline(buffer.join('\n'))}</p>`);
  };

  while (index < lines.length) {
    const line = lines[index];

    // Blank line — separates blocks.
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = FENCE.exec(line);
    if (fence) {
      const language = fence[1].trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1; // consume the closing fence
      const langAttr = language ? ` data-language="${escapeHtml(language)}"` : '';
      html.push(`<pre><code${langAttr}>${escapeHtml(code.join('\n'))}\n</code></pre>`);
      continue;
    }

    // Thematic break.
    if (HR.test(line)) {
      html.push('<hr>');
      index += 1;
      continue;
    }

    // Headings.
    const heading = ATX_HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, Math.max(1, heading[1].length));
      html.push(`<h${level}>${formatInline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    // Blockquote — consume consecutive `>` lines.
    if (BLOCKQUOTE.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && BLOCKQUOTE.test(lines[index])) {
        quote.push((BLOCKQUOTE.exec(lines[index]) as RegExpExecArray)[1]);
        index += 1;
      }
      html.push(`<blockquote><p>${formatInline(quote.join('\n'))}</p></blockquote>`);
      continue;
    }

    // Lists — bullet or ordered; consume consecutive item lines.
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line) && !BULLET.test(line);
      const itemRe = ordered ? ORDERED : BULLET;
      const items: string[] = [];
      while (index < lines.length && itemRe.test(lines[index])) {
        items.push((itemRe.exec(lines[index]) as RegExpExecArray)[1]);
        index += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((item) => `<li>${formatInline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Paragraph — accumulate until a blank line or the start of another block.
    const buffer: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !isBlockStart(lines[index])) {
      buffer.push(lines[index]);
      index += 1;
    }
    if (buffer.length === 0) {
      // The current line IS a block start but was not handled above (should not
      // happen); treat it as a paragraph line to guarantee forward progress.
      buffer.push(lines[index]);
      index += 1;
    }

    // A paragraph that is exactly one image is a BLOCK image in the schema.
    if (buffer.length === 1 && STANDALONE_IMAGE.test(buffer[0])) {
      html.push(formatInline(buffer[0].trim()));
    } else {
      flushParagraph(buffer);
    }
  }

  return html.join('') || '<p></p>';
}

/** Whether a line begins a non-paragraph block (used to stop paragraph buffering). */
function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HR.test(line) || ATX_HEADING.test(line) || BLOCKQUOTE.test(line);
}
