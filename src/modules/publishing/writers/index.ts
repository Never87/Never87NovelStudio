/**
 * Publishing writers.
 *
 * Batch A + B writers are pure string functions over the IR. Batch C adds three
 * BINARY writers (DOCX / EPUB / PDF) plus a single format registry that unifies
 * all six formats behind one async contract.
 *
 *   RenderedDocument ──▶ format registry ──▶ { bytes, mimeType } ──▶ download
 */

export { renderTxt } from './txt-writer';
export { renderMarkdown } from './markdown-writer';
export { renderHtml, escapeHtml } from './html-writer';

/* ---------------------- Batch C binary writers --------------------------- */

export { parseInlineRuns, isPlainText, type InlineRun } from './inline-runs';
export { escapeXml } from './xml-escape';
export { renderDocx } from './docx-writer';
export { renderEpub } from './epub-writer';
export { renderPdf } from './pdf-writer';

/* ------------------------ Format registry (Batch C) ---------------------- */

export {
  EXPORT_FORMATS,
  DEFAULT_EXPORT_FORMAT,
  FONT_FREE_FORMATS,
  isExportFormat,
  getExportFormat,
  type ExportFormat,
  type ExportFormatDescriptor,
} from './format-registry';

/* --------------------------- Writer contract ---------------------------- */

export {
  ExportError,
  EXPORT_ERROR_CODES,
  type ExportErrorCode,
  type ExportPhase,
  type ExportWriterOptions,
  type EpubCoverInput,
  type WriterResult,
} from './writer-types';
