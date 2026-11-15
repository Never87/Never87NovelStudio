/**
 * Export format descriptors (P9 Batch B — Chapter Export).
 *
 * A single mapping from a requested format to (a) the Batch A writer that
 * serialises a `RenderedDocument` and (b) the file extension + MIME type. This
 * keeps writer selection OUT of the React components — download, preview and
 * clipboard all go through these writers, so the three paths can never diverge.
 *
 * No writer logic is re-implemented here; each `render` is the Batch A writer.
 */

import {
  renderHtml,
  renderMarkdown,
  renderTxt,
  type RenderedDocument,
} from '@/modules/publishing';

export type ExportFormat = 'txt' | 'markdown' | 'html';

export interface ExportFormatDescriptor {
  readonly format: ExportFormat;
  readonly label: string;
  /** File extension without a dot. */
  readonly extension: string;
  readonly mimeType: string;
  /** The Batch A writer for this format. */
  readonly render: (doc: RenderedDocument) => string;
}

export const EXPORT_FORMATS: readonly ExportFormatDescriptor[] = [
  {
    format: 'txt',
    label: 'Plain text',
    extension: 'txt',
    mimeType: 'text/plain;charset=utf-8',
    render: renderTxt,
  },
  {
    format: 'markdown',
    label: 'Markdown',
    extension: 'md',
    mimeType: 'text/markdown;charset=utf-8',
    render: renderMarkdown,
  },
  {
    format: 'html',
    label: 'HTML',
    extension: 'html',
    mimeType: 'text/html;charset=utf-8',
    render: renderHtml,
  },
];

export function getExportFormat(format: ExportFormat): ExportFormatDescriptor {
  const descriptor = EXPORT_FORMATS.find((f) => f.format === format);
  if (!descriptor) throw new Error(`Unknown export format "${format}".`);
  return descriptor;
}
