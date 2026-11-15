/**
 * Export format registry (P9 Batch C).
 *
 * A SINGLE mapping from every supported export format to:
 *   - a human label,
 *   - the file extension + MIME type,
 *   - an ASYNC renderer that turns a `RenderedDocument` into bytes.
 *
 * The three Batch A text writers (TXT/MD/HTML) are synchronous; the three binary
 * writers (DOCX/EPUB/PDF) are async. Wrapping them all behind one async `render`
 * gives the export service and UI a uniform contract and guarantees that the
 * format → writer decision lives in exactly ONE place (never duplicated across
 * download / preview / clipboard paths).
 *
 * The PDF entry in this registry is the ONE that needs the font bytes; the service
 * supplies them. The other entries ignore any font bytes passed to them.
 */

import { renderHtml, renderMarkdown, renderTxt, type RenderedDocument } from '@/modules/publishing';
import { renderDocx } from './docx-writer';
import { renderEpub } from './epub-writer';
import { renderPdf } from './pdf-writer';
import type { ExportWriterOptions } from './writer-types';

/** Every format the full-book export supports. */
export type ExportFormat = 'txt' | 'markdown' | 'html' | 'docx' | 'epub' | 'pdf';

/** A single format descriptor. */
export interface ExportFormatDescriptor {
  readonly format: ExportFormat;
  /** Human-readable label for the picker. */
  readonly label: string;
  /** Short description (what the format is good for). */
  readonly description: string;
  /** File extension WITHOUT a leading dot. */
  readonly extension: string;
  readonly mimeType: string;
  /** True when the format produces binary (non-UTF-8-text) bytes. */
  readonly binary: boolean;
  /** True when the format requires the CJK font bytes (PDF only). */
  readonly requiresFont: boolean;
  /**
   * True when the format can embed a cover image supplied via
   * `ExportWriterOptions.cover` (EPUB only, for now). The export service resolves
   * the project's current cover for exactly these formats.
   */
  readonly supportsCover: boolean;
  /** Async renderer: RenderedDocument → file bytes. */
  readonly render: (doc: RenderedDocument, options?: ExportWriterOptions) => Promise<Uint8Array>;
}

/** Wraps a synchronous string writer into the async bytes contract. */
function textRenderer(writer: (doc: RenderedDocument) => string) {
  return async (doc: RenderedDocument): Promise<Uint8Array> => {
    const text = writer(doc);
    return new TextEncoder().encode(text);
  };
}

/** All supported formats, in display order. */
export const EXPORT_FORMATS: readonly ExportFormatDescriptor[] = [
  {
    format: 'txt',
    label: 'Plain text (.txt)',
    description: 'Universal, editable text. Best for editing or importing elsewhere.',
    extension: 'txt',
    mimeType: 'text/plain;charset=utf-8',
    binary: false,
    requiresFont: false,
    supportsCover: false,
    render: textRenderer(renderTxt),
  },
  {
    format: 'markdown',
    label: 'Markdown (.md)',
    description: 'Structured plain text with headings and emphasis.',
    extension: 'md',
    mimeType: 'text/markdown;charset=utf-8',
    binary: false,
    requiresFont: false,
    supportsCover: false,
    render: textRenderer(renderMarkdown),
  },
  {
    format: 'html',
    label: 'HTML (.html)',
    description: 'A self-contained web page you can open in any browser.',
    extension: 'html',
    mimeType: 'text/html;charset=utf-8',
    binary: false,
    requiresFont: false,
    supportsCover: false,
    render: textRenderer(renderHtml),
  },
  {
    format: 'docx',
    label: 'Word document (.docx)',
    description: 'Editable Microsoft Word / WPS document with real styles.',
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    binary: true,
    requiresFont: false,
    supportsCover: false,
    render: (doc, options) => renderDocx(doc, options),
  },
  {
    format: 'epub',
    label: 'EPUB e-book (.epub)',
    description: 'A reflowable e-book for e-readers (Kindle-compatible via conversion).',
    extension: 'epub',
    mimeType: 'application/epub+zip',
    binary: true,
    requiresFont: false,
    supportsCover: true,
    render: (doc, options) => renderEpub(doc, options),
  },
  {
    format: 'pdf',
    label: 'PDF (.pdf)',
    description: 'Fixed-layout document with embedded Chinese font — prints identically everywhere.',
    extension: 'pdf',
    mimeType: 'application/pdf',
    binary: true,
    requiresFont: true,
    supportsCover: false,
    render: (doc, options) => renderPdf(doc, options),
  },
];

/** Formats offered by default FIRST in the UI (the most common ones). */
export const DEFAULT_EXPORT_FORMAT: ExportFormat = 'docx';

/** Fails fast if a format string is not one we support. */
export function isExportFormat(value: string): value is ExportFormat {
  return EXPORT_FORMATS.some((f) => f.format === value);
}

/** Looks up a descriptor, throwing a clear error for an unknown format. */
export function getExportFormat(format: ExportFormat): ExportFormatDescriptor {
  const descriptor = EXPORT_FORMATS.find((f) => f.format === format);
  if (!descriptor) throw new Error(`Unknown export format "${format}".`);
  return descriptor;
}

/** Formats that DO NOT need font bytes (used to gate the PDF-available state). */
export const FONT_FREE_FORMATS: readonly ExportFormat[] = EXPORT_FORMATS.filter(
  (f) => !f.requiresFont,
).map((f) => f.format);
