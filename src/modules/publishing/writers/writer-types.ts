/**
 * Writer contract & shared options (P9 Batch C — Full-book Export).
 *
 * Every format writer (TXT/Markdown/HTML/DOCX/EPUB/PDF) consumes the SAME
 * `RenderedDocument` produced by the Batch A `FormattingPipeline` and returns
 * the raw bytes of the final file plus the metadata a caller needs to turn it
 * into a download. Nothing here touches the DOM, React, Dexie or the network —
 * writers are pure functions over the IR (plus, for PDF, the font bytes).
 *
 * The three binary writers (DOCX/EPUB/PDF) are ASYNC because their libraries
 * serialise asynchronously. The three Batch A text writers remain synchronous;
 * the format registry (`format-registry.ts`) wraps them so callers see one
 * uniform async contract.
 */

/**
 * Options passed to every writer.
 *
 * Writers NEVER invent a filename or MIME type on their own: the filename base
 * and extension come from the preset + filename utilities at the service layer.
 * A writer only needs the document metadata it cannot derive from the IR (it
 * already carries `metadata`), and, for PDF, the embedded font bytes.
 */
export interface ExportWriterOptions {
  /**
   * Already-resolved base title used for DOCX/EPUB document properties. The final
   * FILE name is decided by the export service; this is only for internal
   * metadata (core properties / OPF title), defaulting to the IR title.
   */
  readonly title?: string;
  /** Author for internal metadata, defaulting to the IR author. */
  readonly author?: string;
  /** BCP-47 language tag; defaults to the IR language. */
  readonly language?: string;
  /** Epoch millis recorded in file metadata; defaults to `Date.now()`. */
  readonly modifiedAt?: number;
  /**
   * PDF only: the raw bytes of the bundled CJK font to embed. Required for PDF;
   * ignored by the other writers. Kept as an explicit input so the writer stays
   * pure and testable in Node (the browser fetches it, tests read it from disk).
   */
  readonly fontBytes?: Uint8Array;
  /**
   * PDF only: base64 font bytes, for callers that already hold a data URL. Either
   * `fontBytes` or `fontDataBase64` must be supplied for PDF.
   */
  readonly fontDataBase64?: string;
  /**
   * EPUB only: optional cover image slots reserved for a future Book Covers
   * integration. When present, the EPUB declares a cover page + image in the OPF
   * manifest. Batch C never populates this; the interface exists so the EPUB
   * structure is forward-compatible.
   */
  readonly cover?: EpubCoverInput;
}

/** A cover image that a future Book Covers module can supply to the EPUB writer. */
export interface EpubCoverInput {
  /** Image bytes (PNG or JPEG). */
  readonly bytes: Uint8Array;
  /** MIME type, e.g. `image/png` or `image/jpeg`. */
  readonly mimeType: 'image/png' | 'image/jpeg';
  /** Manifest id (file name inside OEBPS/images). Defaults to `cover`. */
  readonly fileName?: string;
  /** Optional `epub:type="cover"` alt text. */
  readonly altText?: string;
}

/**
 * The result every binary writer returns: the file bytes. The export service
 * pairs these with a filename/MIME to build the final download.
 */
export interface WriterResult {
  /** The complete file bytes. */
  readonly bytes: Uint8Array;
  /** MIME type of `bytes` (so the service never has to guess). */
  readonly mimeType: string;
}

/* ========================================================================== */
/* Errors                                                                     */
/* ========================================================================== */

/** Stable machine-readable codes for the export layer. */
export const EXPORT_ERROR_CODES = [
  /** A writer could not serialise the document (library threw). */
  'writer-failed',
  /** The PDF writer was invoked without font bytes. */
  'font-missing',
  /** The supplied font bytes are not a usable font. */
  'font-invalid',
  /** The project (or its data) could not be loaded for export. */
  'assembly-failed',
  /** The project id did not resolve to a project. */
  'project-not-found',
  /** A requested format is not a known export format. */
  'unknown-format',
] as const;

export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

/**
 * The single error type raised by the publishing/export layer.
 *
 * - `code` is a stable machine-readable discriminator.
 * - `phase` records which stage failed, so the UI can react precisely:
 *   `assemble` → `format` → `write` → `finalize`.
 */
export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly phase: ExportPhase;
  readonly cause?: unknown;

  constructor(
    code: ExportErrorCode,
    phase: ExportPhase,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.phase = phase;
    this.cause = cause;
  }
}

/** The stage of an export at which an `ExportError` occurred. */
export type ExportPhase = 'assemble' | 'format' | 'write' | 'finalize';
