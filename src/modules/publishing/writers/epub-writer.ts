/**
 * EPUB 3 writer (P9 Batch C).
 *
 * Serialises a `RenderedDocument` into a valid EPUB 3 publication using JSZip
 * (MIT). It consumes ONLY the IR — the chapter order is exactly the order of
 * `RenderedDocument.volumes[*].chapters`, so the ebook spine can never diverge
 * from the preview or the other formats.
 *
 * Package layout (EPUB 3):
 *
 *   mimetype                     (first entry, STORED/uncompressed — spec requires)
 *   META-INF/container.xml       (points at OEBPS/content.opf)
 *   OEBPS/content.opf            (metadata + manifest + spine + nav)
 *   OEBPS/nav.xhtml              (EPUB 3 navigation document, with toc)
 *   OEBPS/styles/main.css        (typography, CJK-aware font stack)
 *   OEBPS/text/chapter-NNN.xhtml (one XHTML document per chapter)
 *
 * Requirements honoured:
 * - `mimetype` is the FIRST zip entry and is NOT compressed.
 * - OPF `metadata`/`manifest`/`spine` are complete and every referenced item is
 *   present; `nav.xhtml` is `properties="nav"` and listed in the spine.
 * - Each chapter's XHTML is well-formed and every manuscript string is XML-
 *   escaped (raw HTML in prose becomes text, never markup).
 * - A cover-image slot is declared behind `EpubCoverInput` for a future Book
 *   Covers module; Batch C does not populate it, but the manifest/`<guide>` path
 *   is ready.
 *
 * No external resources: no remote fonts, no remote images.
 */

import JSZip from 'jszip';
import type { RenderedBlock, RenderedChapter, RenderedDocument } from '../types';
import type { ExportWriterOptions } from './writer-types';
import { escapeXml } from './xml-escape';

/** EPUB 3 requires a fixed UUID; a stable namespace is enough for an offline build. */
const OPF_NAMESPACE = 'http://www.idpf.org/2007/opf';
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
/** Identifier scheme namespace for our generated book ids. */
const UID_PREFIX = 'urn:uuid:';

/** Fixed epoch for deterministic zip entry dates (avoids noisy diffs in tests). */
const FIXED_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/** Zero-pads a chapter index to a stable file-name width. */
function chapterFile(index: number): string {
  return `chapter-${String(index).padStart(3, '0')}.xhtml`;
}

/**
 * Deterministic, offline book id derived from title + author. It does not need
 * to be a real UUID; the OPF only requires a unique identifier string.
 */
function deriveBookId(doc: RenderedDocument, title: string, author: string): string {
  const seed = `${title}::${author}::${doc.presetId}::${doc.volumes.length}`;
  // FNV-1a 32-bit hash rendered as hex, repeated to a UUID-like shape.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  return `${UID_PREFIX}${hex}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-n87${hex}-studio`;
}

/** Renders one block to an XHTML fragment (paragraph/heading/hr). */
function blockToXhtml(block: RenderedBlock, useInlineMarkup: (s: string) => string): string {
  switch (block.type) {
    case 'heading': {
      const tag = `h${block.level}`;
      const text = block.text
        .split('\n\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(useInlineMarkup)
        .join('<br/>');
      return `<${tag}>${text}</${tag}>`;
    }
    case 'scene-break':
      return `<p class="scene-break">${escapeXml(block.text)}</p>`;
    case 'paragraph':
    default: {
      const text = block.text
        .split('\n')
        .map(useInlineMarkup)
        .join('<br/>');
      return `<p>${text}</p>`;
    }
  }
}

/** Builds one chapter XHTML document string. */
function chapterToXhtml(
  chapter: RenderedChapter,
  title: string,
  language: string,
  useInlineMarkup: (s: string) => string,
): string {
  const bodyBlocks =
    chapter.blocks.length > 0
      ? chapter.blocks.map((b) => blockToXhtml(b, useInlineMarkup)).join('\n')
      : `<h2>${escapeXml(chapter.title)}</h2>`;
  const lang = language || 'und';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">`,
    '<head>',
    '  <meta charset="utf-8"/>',
    `  <title>${escapeXml(chapter.title || title)}</title>`,
    '  <link rel="stylesheet" type="text/css" href="../styles/main.css"/>',
    '</head>',
    '<body>',
    bodyBlocks,
    '</body>',
    '</html>',
  ].join('\n');
}

/** The shared stylesheet (CJK-aware font stack, no external fonts). */
const STYLE_CSS = [
  'html{font-size:100%;}',
  'body{font-family:"Noto Sans SC","Songti SC","Microsoft YaHei",serif;line-height:1.7;margin:0;padding:1em 1.2em;color:#111;}',
  'h1,h2,h3{line-height:1.3;margin:1.4em 0 0.6em;}',
  'p{margin:0 0 0.8em;text-indent:2em;}',
  'p.scene-break{text-indent:0;text-align:center;margin:1.2em 0;font-style:italic;}',
  'body > h2:first-child{margin-top:0;}',
].join('\n');

/**
 * Renders the EPUB 3 navigation document (nav + toc), one entry per chapter.
 */
function navXhtml(doc: RenderedDocument, title: string, language: string): string {
  const lang = language || 'und';
  let chapterNumber = 0;
  const volumeItems: string[] = [];
  for (const volume of doc.volumes) {
    const chapterLinks: string[] = [];
    for (const chapter of volume.chapters) {
      chapterNumber += 1;
      chapterLinks.push(
        `        <li><a href="text/${chapterFile(chapterNumber)}">${escapeXml(chapter.title)}</a></li>`,
      );
    }
    const volumeTitle = volume.title || `Volume`;
    volumeItems.push(
      [
        '      <li>',
        `        <span>${escapeXml(volumeTitle)}</span>`,
        '        <ol>',
        ...chapterLinks,
        '        </ol>',
        '      </li>',
      ].join('\n'),
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE html>',
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(lang)}" lang="${escapeXml(lang)}">`,
    '<head>',
    '  <meta charset="utf-8"/>',
    `  <title>${escapeXml(title)}</title>`,
    '  <link rel="stylesheet" type="text/css" href="styles/main.css"/>',
    '</head>',
    '<body>',
    '  <nav epub:type="toc" id="toc">',
    '    <h1>Contents</h1>',
    '    <ol>',
    ...volumeItems,
    '    </ol>',
    '  </nav>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * Serialises a `RenderedDocument` into EPUB 3 bytes.
 *
 * @param doc     The formatted intermediate representation.
 * @param options Metadata overrides + optional future cover.
 * @returns The `.epub` bytes (a ZIP archive).
 */
export async function renderEpub(
  doc: RenderedDocument,
  options: ExportWriterOptions = {},
): Promise<Uint8Array> {
  const title = (options.title ?? doc.metadata.title ?? '').trim() || 'Untitled';
  const author = (options.author ?? doc.metadata.author ?? '').trim();
  const language = (options.language ?? doc.metadata.language ?? '').trim();
  const modified = new Date(options.modifiedAt ?? Date.now());

  // Small, safe inline subset: bold/italic/code. Input is escaped FIRST so no raw
  // HTML survives; only our known tags are inserted on top of escaped text.
  const useInlineMarkup = (raw: string): string => {
    let out = escapeXml(raw);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    return out;
  };

  type ChapterEntry = { index: number; xhtml: string; chapter: RenderedChapter };
  const chapters: ChapterEntry[] = [];
  let chapterNumber = 0;
  for (const volume of doc.volumes) {
    for (const chapter of volume.chapters) {
      chapterNumber += 1;
      chapters.push({
        index: chapterNumber,
        chapter,
        xhtml: chapterToXhtml(chapter, title, language, useInlineMarkup),
      });
    }
  }

  // ---- OPF manifest & spine --------------------------------------------
  const manifestItems: string[] = [
    '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '    <item id="css" href="styles/main.css" media-type="text/css"/>',
  ];
  const spineItems: string[] = ['    <itemref idref="nav"/>'];
  for (const entry of chapters) {
    const id = `ch${entry.index}`;
    manifestItems.push(
      `    <item id="${id}" href="text/${chapterFile(entry.index)}" media-type="application/xhtml+xml"/>`,
    );
    spineItems.push(`    <itemref idref="${id}"/>`);
  }

  // Cover slot: declared only when a cover is supplied. The cover PAGE
  // (`cover.xhtml`) is a real XHTML resource, so it MUST be declared in the
  // manifest and placed FIRST in the spine (cover precedes the nav/chapters in
  // EPUB reading order). The image is marked `properties="cover-image"` and the
  // legacy `<meta name="cover">` + `<guide type="cover">` references are kept
  // for maximum reader compatibility.
  let coverManifest = '';
  let coverMeta = '';
  let coverGuide = '';
  const cover = options.cover;
  if (cover) {
    const coverName = cover.fileName ?? (cover.mimeType === 'image/png' ? 'cover.png' : 'cover.jpg');
    coverManifest =
      `\n    <item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>` +
      `\n    <item id="cover-image" href="images/${escapeXml(coverName)}" media-type="${cover.mimeType}" properties="cover-image"/>`;
    coverMeta = '\n    <meta name="cover" content="cover-image"/>';
    coverGuide = '\n    <reference type="cover" title="Cover" href="text/cover.xhtml"/>';
    // Cover page first, then nav (nav must remain in the spine), then chapters.
    spineItems.unshift('    <itemref idref="cover-page" linear="yes"/>');
  }

  const bookId = deriveBookId(doc, title, author);
  const opf = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<package xmlns="${OPF_NAMESPACE}" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(language || 'und')}">`,
    '  <metadata xmlns:dc="' + DC_NAMESPACE + '">',
    `    <dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>`,
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    `    <dc:language>${escapeXml(language || 'und')}</dc:language>`,
    ...(author ? [`    <dc:creator>${escapeXml(author)}</dc:creator>`] : []),
    `    <meta property="dcterms:modified">${modified.toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta>`,
    ...(coverMeta ? [coverMeta.trim()] : []),
    '  </metadata>',
    '  <manifest>',
    ...manifestItems,
    ...(coverManifest ? [coverManifest.trim()] : []),
    '  </manifest>',
    '  <spine>',
    ...spineItems,
    '  </spine>',
    '  <guide>',
    `    <reference type="toc" title="Contents" href="nav.xhtml"/>${coverGuide}`,
    '  </guide>',
    '</package>',
  ].join('\n');

  const container = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '  <rootfiles>',
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>',
    '  </rootfiles>',
    '</container>',
  ].join('\n');

  // ---- Assemble the ZIP -------------------------------------------------
  const zip = new JSZip();

  // (1) mimetype — MUST be first, and MUST be STORE (uncompressed).
  zip.file('mimetype', 'application/epub+zip', {
    compression: 'STORE',
    date: FIXED_DATE,
  });

  // (2) container.
  zip.file('META-INF/container.xml', container, { date: FIXED_DATE });

  // (3) OPF + nav + css.
  zip.file('OEBPS/content.opf', opf, { date: FIXED_DATE });
  zip.file('OEBPS/nav.xhtml', navXhtml(doc, title, language), { date: FIXED_DATE });
  zip.file('OEBPS/styles/main.css', STYLE_CSS, { date: FIXED_DATE });

  // (4) chapters.
  for (const entry of chapters) {
    zip.file(`OEBPS/text/${chapterFile(entry.index)}`, entry.xhtml, { date: FIXED_DATE });
  }

  // (5) optional cover image (future Book Covers integration).
  if (cover) {
    const coverName = cover.fileName ?? (cover.mimeType === 'image/png' ? 'cover.png' : 'cover.jpg');
    zip.file(`OEBPS/images/${coverName}`, cover.bytes, { date: FIXED_DATE });
    // Minimal cover page + an alt-text honouring XHTML wrapper.
    const coverXhtml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE html>',
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(language || 'und')}">`,
      '<head><meta charset="utf-8"/><title>Cover</title></head>',
      '<body><section epub:type="cover">',
      `<img src="../images/${escapeXml(coverName)}" alt="${escapeXml(cover.altText ?? 'Cover')}"/>`,
      '</section></body></html>',
    ].join('\n');
    zip.file('OEBPS/text/cover.xhtml', coverXhtml, { date: FIXED_DATE });
  }

  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    // `mimetype` was added first with STORE; keep insertion order.
    platform: 'DOS',
  });
  return buffer;
}
