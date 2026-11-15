/**
 * Full-book export service (P9 Batch C).
 *
 * The orchestration layer that turns a project id + an export format into a
 * ready-to-download file. It REUSES the entire Batch A/B stack end to end:
 *
 *   projectId
 *     → bookAssemblyService.assembleBook (read-only, whole book)
 *     → FormattingPipeline.render(model, preset)   (the shared IR)
 *     → format registry writer                     (TXT/MD/HTML/DOCX/EPUB/PDF)
 *     → { bytes, fileName, mimeType }
 *
 * Guarantees
 * ----------
 * - READ-ONLY: nothing is written to the database — no saves, versions,
 *   snapshots or draft mutations. It only reads via the existing assembly service.
 * - SINGLE SOURCE OF TRUTH: the chapter ORDER is exactly what `assembleBook`
 *   returns, and the FORMAT decision lives in the registry — never duplicated.
 * - NO UI assumptions beyond "produce bytes + a filename": file-name generation
 *   uses the preset template + Batch A `buildFileNameFromTemplate` (filesystem-
 *   safe, Unicode-safe).
 * - PDF: the bundled CJK font bytes are loaded on demand (browser) or supplied
 *   explicitly (tests), so PDF export never depends on system fonts.
 *
 * The service throws `ExportError` with a stable `code`/`phase` so the UI can show
 * a precise message; it never swallows a failure into a partial/blank file.
 */

import { bookAssemblyService, type BookAssemblyService } from '@/services';
import {
  FormattingPipeline,
  buildFileNameFromTemplate,
  ExportError,
  getExportFormat,
  renderHtml,
  type ExportFormat,
  type RenderedDocument,
  type PublishingPreset,
  type ExportWriterOptions,
} from '@/modules/publishing';
import { loadPdfFontBytes } from '@/modules/publishing/pdf-font';
import { coverService } from './cover-service';

/**
 * A stored cover a project can contribute to a cover-capable export (EPUB).
 * Resolved by the caller (the cover service) so the export service stays free
 * of DB/blob knowledge and remains pure-testable.
 */
export type ExportCoverInput = {
  readonly bytes: Uint8Array;
  readonly mimeType: 'image/png' | 'image/jpeg';
};

/** A produced export, ready to download. */
export interface FullBookExportResult {
  readonly format: ExportFormat;
  /** The complete file bytes. */
  readonly bytes: Uint8Array;
  /** Safe file name including extension. */
  readonly fileName: string;
  readonly mimeType: string;
  /** Convenience copy of the rendered document that produced these bytes. */
  readonly document: RenderedDocument;
}

/** Injectable dependencies (defaults = the shared app services / loaders). */
export interface FullBookExportDeps {
  /** Read-only whole-book assembly. Defaults to the shared singleton. */
  readonly assembly?: Pick<BookAssemblyService, 'assembleBook'>;
  /** Font-bytes loader for PDF (defaults to the bundled-font loader). */
  readonly loadFontBytes?: () => Promise<Uint8Array>;
  /** Pipeline instance (defaults to a fresh one). */
  readonly pipeline?: FormattingPipeline;
  /** Clock, for deterministic tests. */
  readonly now?: () => number;
  /**
   * Cover provider: resolves the project's stored cover for a cover-capable
   * format (EPUB). Returns `null`/`undefined` when the project has no embeddable
   * cover. Providing it is optional; when omitted, exports carry no cover.
   */
  readonly resolveCover?: (projectId: string, format: ExportFormat) => Promise<ExportCoverInput | null>;
}

/** Options for a single full-book export. */
export interface FullBookExportOptions {
  /** The preset whose rules drive formatting, filename template and metadata. */
  readonly preset: PublishingPreset;
  /** The target format. */
  readonly format: ExportFormat;
  /**
   * Pre-loaded font bytes for PDF. When omitted the service loads the bundled
   * font (browser). PDF only; ignored for other formats.
   */
  readonly fontBytes?: Uint8Array;
  /** Override the file-name template (defaults to `preset.fileNameTemplate`). */
  readonly fileNameTemplate?: string;
}

/**
 * Produces a full-book export for `projectId` in the requested format.
 *
 * @throws {ExportError}
 *   - `assembly-failed` when the book cannot be assembled/rendered
 *   - `project-not-found` when the project does not exist
 *   - `unknown-format` when `format` is not supported
 *   - `font-missing`/`font-invalid` when PDF export lacks a usable font
 *   - `writer-failed` when the writer cannot serialise
 */
export async function exportFullBook(
  projectId: string,
  options: FullBookExportOptions,
  deps: FullBookExportDeps = {},
): Promise<FullBookExportResult> {
  const assembly = deps.assembly ?? bookAssemblyService;
  const pipeline = deps.pipeline ?? new FormattingPipeline();
  const now = deps.now ?? Date.now;

  if (!getExportFormatSafe(options.format)) {
    throw new ExportError('unknown-format', 'format', `Unsupported export format "${options.format}".`);
  }
  const descriptor = getExportFormat(options.format);

  // 1) Assemble the WHOLE book (read-only). A missing project surfaces here.
  let model;
  try {
    model = await assembly.assembleBook(projectId, { includeSceneCounts: false });
  } catch (error) {
    // A project that does not exist is a distinct, user-actionable failure.
    if (isNotFound(error)) {
      throw new ExportError('project-not-found', 'assemble', `Project "${projectId}" was not found.`, error);
    }
    throw new ExportError(
      'assembly-failed',
      'assemble',
      'The manuscript could not be assembled for export.',
      error,
    );
  }

  // 2) Render to the shared IR exactly once.
  let document: RenderedDocument;
  try {
    document = pipeline.render(model, options.preset);
  } catch (error) {
    throw new ExportError('assembly-failed', 'format', 'The manuscript could not be formatted.', error);
  }

  // 3) Resolve font bytes for PDF (loaded on demand; never for other formats).
  let fontBytes: Uint8Array | undefined;
  if (descriptor.requiresFont) {
    if (options.fontBytes && options.fontBytes.byteLength > 0) {
      fontBytes = options.fontBytes;
    } else {
      const loader = deps.loadFontBytes ?? loadPdfFontBytes;
      try {
        fontBytes = await loader();
      } catch (error) {
        throw new ExportError(
          'font-missing',
          'write',
          'The bundled Chinese font could not be loaded, so PDF export is unavailable right now.',
          error,
        );
      }
    }
  }

  // 4) Serialise via the registry writer.
  //    EPUB can embed a cover; resolve it (if any) through the injected provider
  //    so this service stays free of blob/DB knowledge. A missing cover is fine.
  let cover: ExportCoverInput | undefined;
  if (descriptor.supportsCover) {
    const resolver = deps.resolveCover ?? ((pid: string) => coverService.getCoverBytesForExport(pid));
    try {
      const resolved = await resolver(projectId, options.format);
      if (resolved && resolved.bytes.byteLength > 0) cover = resolved;
    } catch (error) {
      // A cover that cannot be resolved must not abort the export — the book is
      // far more valuable than its cover. Log and continue WITHOUT a cover.
      console.error('[export] Could not resolve a cover for the export; continuing without one.', error);
    }
  }

  const writerOptions: ExportWriterOptions = {
    title: document.metadata.title,
    author: document.metadata.author,
    language: document.metadata.language,
    modifiedAt: now(),
    ...(fontBytes ? { fontBytes } : {}),
    ...(cover ? { cover } : {}),
  };

  let bytes: Uint8Array;
  try {
    bytes = await descriptor.render(document, writerOptions);
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError('writer-failed', 'write', `Failed to produce the ${descriptor.label}.`, error);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw new ExportError('writer-failed', 'write', `The ${descriptor.label} came out empty.`);
  }

  // 5) Build a safe, preset-driven file name.
  const template = options.fileNameTemplate ?? options.preset.fileNameTemplate;
  const fileName = buildFileNameFromTemplate(
    template,
    { title: document.metadata.title, author: document.metadata.author },
    descriptor.extension,
  );

  return {
    format: options.format,
    bytes,
    fileName,
    mimeType: descriptor.mimeType,
    document,
  };
}

/* -------------------------------- preview -------------------------------- */

/** Injectable dependencies for {@link previewFullBook}. */
export interface FullBookPreviewDeps {
  /** Read-only whole-book assembly. Defaults to the shared singleton. */
  readonly assembly?: Pick<BookAssemblyService, 'assembleBook'>;
  /** Pipeline instance (defaults to a fresh one). */
  readonly pipeline?: FormattingPipeline;
}

/** A rendered, read-only preview of the whole book. */
export interface FullBookPreviewResult {
  /** The shared IR a download will also derive from (identical formatting). */
  readonly document: RenderedDocument;
  /** The same IR serialised through the Batch A HTML writer (display only). */
  readonly html: string;
  /** Lightweight stats for the UI (walked from the IR, never re-parsed prose). */
  readonly stats: {
    readonly volumes: number;
    readonly chapters: number;
    readonly words: number;
    readonly blocks: number;
  };
}

/**
 * Produces a READ-ONLY preview of the whole book as it will appear when exported.
 *
 * It runs the EXACT same front half of {@link exportFullBook} —
 * `assembleBook` → `FormattingPipeline.render` — so the preview is derived from
 * the SAME `RenderedDocument` (IR) that every writer consumes, then serialises
 * that IR with the EXISTING Batch A HTML writer (`renderHtml`) purely for
 * display. There is no second formatting path: the preview cannot diverge from a
 * download because both share one IR and one preset application.
 *
 * The preview produces no file bytes, never touches the PDF font, and is fully
 * read-only (no DB writes, no snapshots, no draft mutation).
 *
 * @throws {ExportError} `project-not-found` / `assembly-failed` — the same
 *   mapping as a download, so a preview failure surfaces identically.
 */
export async function previewFullBook(
  projectId: string,
  options: { preset: PublishingPreset },
  deps: FullBookPreviewDeps = {},
): Promise<FullBookPreviewResult> {
  const assembly = deps.assembly ?? bookAssemblyService;
  const pipeline = deps.pipeline ?? new FormattingPipeline();

  // 1) Assemble the WHOLE book (read-only) — identical to the export path.
  let model;
  try {
    model = await assembly.assembleBook(projectId, { includeSceneCounts: false });
  } catch (error) {
    if (isNotFound(error)) {
      throw new ExportError('project-not-found', 'assemble', `Project "${projectId}" was not found.`, error);
    }
    throw new ExportError('assembly-failed', 'assemble', 'The manuscript could not be assembled for preview.', error);
  }

  // 2) Apply the preset EXACTLY ONCE — the same IR a download uses.
  let document: RenderedDocument;
  try {
    document = pipeline.render(model, options.preset);
  } catch (error) {
    throw new ExportError('assembly-failed', 'format', 'The manuscript could not be formatted.', error);
  }

  // 3) Serialise the SAME IR with the existing HTML writer (display only).
  const html = renderHtml(document);

  // 4) Derive display stats by walking the IR (no re-parsing of prose).
  let chapters = 0;
  let blocks = document.header ? 1 : 0;
  for (const volume of document.volumes) {
    if (volume.heading) blocks += 1;
    chapters += volume.chapters.length;
    for (const chapter of volume.chapters) blocks += chapter.blocks.length;
  }

  return {
    document,
    html,
    stats: {
      volumes: document.volumes.length,
      chapters,
      words: model.totalWords,
      blocks,
    },
  };
}

/* ------------------------------- helpers --------------------------------- */

/** `getExportFormat` throws; a boolean guard lets us raise our own typed error. */
function getExportFormatSafe(format: string): boolean {
  try {
    getExportFormat(format as ExportFormat);
    return true;
  } catch {
    return false;
  }
}

/** Recognises a "not found" failure from the assembly layer without importing it. */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /not found/i.test(message);
}

/* ------------------------------ download --------------------------------- */

/**
 * Triggers a browser download of the produced bytes.
 *
 * Kept in the service (not the component) so EVERY download path — full-book and
 * chapter — uses one well-tested Blob/anchor implementation with object-URL
 * cleanup. Safe to call from a component event handler.
 */
export function downloadExport(result: Pick<FullBookExportResult, 'bytes' | 'fileName' | 'mimeType'>): void {
  // Copy into a fresh ArrayBuffer-backed view so the Blob never aliases a pooled
  // buffer the writer may still hold.
  const copy = new Uint8Array(result.bytes.byteLength);
  copy.set(result.bytes);
  const blob = new Blob([copy], { type: result.mimeType });
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
