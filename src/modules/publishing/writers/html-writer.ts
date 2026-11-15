/**
 * HTML writer (P9 Batch A).
 *
 * Serialises a `RenderedDocument` into a complete, self-contained UTF-8 HTML
 * document. It consumes ONLY the IR and treats every piece of manuscript text
 * as UNTRUSTED:
 *
 *  - All text is HTML-escaped first (`& < > " '`). Raw manuscript HTML like
 *    `<script>` is therefore never injected — it appears as literal text.
 *  - A deliberately SMALL, safe subset of inline Markdown is rendered on top of
 *    the ESCAPED text: `**bold**`, `*italic*`, `` `code` ``. Links are NOT
 *    turned into anchors (avoids `javascript:`/attribute injection); their text
 *    is kept and the URL is dropped. This is an intentional, documented
 *    limitation — the manuscript text is never lost, only the link target is
 *    not emitted.
 *
 * No `dangerouslySetInnerHTML` is involved: this writer produces a string that
 * the caller turns into a Blob/download; it is not inserted into the live React
 * tree.
 */

import type { RenderedBlock, RenderedChapter, RenderedDocument, RenderedVolume } from '../types';

/** Escapes text for safe inclusion in HTML element content and attributes. */
export function escapeHtml(text: string): string {
  return (text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a small, safe subset of inline Markdown into HTML.
 *
 * The input is escaped FIRST, then a few well-bounded patterns are applied. The
 * patterns operate on the escaped string and only ever insert known-safe tags.
 * Links keep their visible text (the URL is discarded — see module docs).
 */
function renderInline(text: string): string {
  // 1) Escape everything up front so no raw HTML can survive.
  let out = escapeHtml(text);

  // 2) Images/links → visible text only (URL dropped; text kept, never lost).
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 3) Inline code: `code` → <code>code</code>. Do this before emphasis so
  //    markers inside code are not treated as emphasis.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);

  // 4) Bold then italic (order matters: ** before *).
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => `<strong>${inner}</strong>`);
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, (_m, pre: string, inner: string) => `${pre}<em>${inner}</em>`);

  return out;
}

function blockToHtml(block: RenderedBlock): string {
  switch (block.type) {
    case 'heading': {
      const tag = `h${block.level}`;
      // A heading text may contain multiple Markdown lines (e.g. title +
      // author); render each as inline and join with a break.
      const inner = block.text
        .split('\n\n')
        .map((part) => renderInline(part.trim()))
        .filter((part) => part.length > 0)
        .join('<br>');
      return `<${tag}>${inner}</${tag}>`;
    }
    case 'scene-break':
      return `<p class="scene-break">${escapeHtml(block.text)}</p>`;
    case 'paragraph':
    default:
      // Paragraph text may hold soft line breaks; join with <br> and escape.
      {
        const inner = block.text
          .split('\n')
          .map((line) => renderInline(line))
          .join('<br>');
        return `<p>${inner}</p>`;
      }
  }
}

function blocksToHtml(blocks: readonly RenderedBlock[], indent: string): string {
  return blocks
    .map((block) => `${indent}${blockToHtml(block)}`)
    .join('\n');
}

function chapterToHtml(chapter: RenderedChapter, indent: string): string {
  const inner = blocksToHtml(chapter.blocks, `${indent}  `);
  return `${indent}<section class="chapter" data-chapter-id="${escapeHtml(chapter.id)}">\n${inner}\n${indent}</section>`;
}

function volumeToHtml(volume: RenderedVolume, indent: string): string {
  const parts: string[] = [];
  if (volume.heading) {
    parts.push(`${indent}  ${blockToHtml(volume.heading)}`);
  }
  for (const chapter of volume.chapters) {
    parts.push(chapterToHtml(chapter, `${indent}  `));
  }
  return `${indent}<section class="volume" data-volume-id="${escapeHtml(volume.id)}">\n${parts.join('\n')}\n${indent}</section>`;
}

/** Minimal, safe stylesheet inlined into the document `<head>`. */
const STYLE = [
  'body{font-family:Georgia,"Songti SC","Microsoft YaHei",serif;line-height:1.6;max-width:42em;margin:2em auto;padding:0 1em;color:#1a1a1a;}',
  'h1,h2,h3{line-height:1.3;}',
  'p{margin:0 0 0.8em;text-indent:2em;}',
  'p.scene-break{text-indent:0;text-align:center;margin:1.2em 0;}',
  'code{background:#f2f2f2;padding:0.1em 0.3em;border-radius:3px;}',
].join('\n');

/**
 * Serialises a `RenderedDocument` into a complete HTML document string.
 *
 * The output is a full `<!DOCTYPE html>` document with UTF-8 charset and a
 * language attribute derived from the document metadata.
 */
export function renderHtml(doc: RenderedDocument): string {
  const lang = doc.metadata.language && doc.metadata.language.trim() !== ''
    ? escapeHtml(doc.metadata.language.trim())
    : 'und';
  const titleText = doc.metadata.title && doc.metadata.title.trim() !== ''
    ? doc.metadata.title.trim()
    : 'Manuscript';

  const bodyParts: string[] = [];
  if (doc.header) {
    bodyParts.push(`  <header>\n    ${blockToHtml(doc.header)}\n  </header>`);
  }
  for (const volume of doc.volumes) {
    bodyParts.push(volumeToHtml(volume, '  '));
  }

  return [
    '<!DOCTYPE html>',
    `<html lang="${lang}">`,
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${escapeHtml(titleText)}</title>`,
    ...(doc.metadata.author && doc.metadata.author.trim() !== ''
      ? [`  <meta name="author" content="${escapeHtml(doc.metadata.author.trim())}">`]
      : []),
    '  <style>',
    STYLE,
    '  </style>',
    '</head>',
    '<body>',
    ...bodyParts,
    '</body>',
    '</html>',
  ].join('\n');
}
