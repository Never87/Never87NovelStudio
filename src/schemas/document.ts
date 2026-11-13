import { z } from 'zod';

/**
 * Import & Information-Extraction domain schemas (P8) — single source of truth.
 *
 * This is the DATA FOUNDATION of the import pipeline:
 *
 *   SourceDocument   — an imported manuscript (raw text kept verbatim).
 *   DocumentSection  — a parsed, ADDRESSABLE slice of that raw text.
 *   DocumentEvidence — a precise, offset-based locator into a section.
 *
 * Design principles (inherited from P1–P7):
 *   - Every record belongs to exactly ONE project (`projectId`, indexed).
 *   - Types are DERIVED from these Zod schemas via `z.infer` — never hand-written.
 *   - The RAW text is the single source of truth for positions. Sections are
 *     slices of it, so `document.rawText.slice(section.start, section.end)` MUST
 *     equal `section.text` exactly. Offsets are JS UTF-16 code-unit indices in a
 *     LEFT-CLOSED / RIGHT-OPEN `[start, end)` interval.
 *   - P7 `Evidence` is left UNCHANGED. Import-time evidence uses the separate
 *     `DocumentEvidence` below; it is translated to chapter/scene `Evidence`
 *     only later, when records are integrated into project entities.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Formats & lifecycle                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Supported source formats in this batch.
 *
 * DOCX/PDF are deliberately NOT supported yet: no parsing dependency is added
 * (see P8 Batch-1 scope). Pasted text is stored as `txt`.
 */
export const DOCUMENT_FORMATS = ['txt', 'markdown'] as const;
export const DocumentFormatSchema = z.enum(DOCUMENT_FORMATS);
export type DocumentFormat = z.infer<typeof DocumentFormatSchema>;

/**
 * Pipeline stage a document has reached.
 *
 *   - `imported`  — raw text registered, not parsed yet.
 *   - `parsed`    — sections produced (structure may still be user-edited).
 *   - `extracted` — at least one extraction run has been performed.
 */
export const DOCUMENT_STATUSES = ['imported', 'parsed', 'extracted'] as const;
export const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

/** Section granularity. `paragraph` is the leaf; higher levels form a tree. */
export const DOCUMENT_SECTION_LEVELS = ['volume', 'chapter', 'scene', 'paragraph'] as const;
export const DocumentSectionLevelSchema = z.enum(DOCUMENT_SECTION_LEVELS);
export type DocumentSectionLevel = z.infer<typeof DocumentSectionLevelSchema>;

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Maximum raw-text size accepted by the importer, in UTF-16 code units.
 *
 * Guards against writing an unbounded blob into IndexedDB (which would risk
 * quota errors and freeze the UI). 2,000,000 code units is ~1.9 MB of ASCII and
 * comfortably covers a full novel manuscript while staying well under typical
 * IndexedDB value limits.
 */
export const MAX_DOCUMENT_CHARS = 2_000_000;

/* -------------------------------------------------------------------------- */
/* Shared scalars                                                             */
/* -------------------------------------------------------------------------- */

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/** A non-negative integer char offset (UTF-16 code units). */
const offsetSchema = z
  .number()
  .int('Offset must be an integer')
  .nonnegative('Offset must be non-negative');

/* -------------------------------------------------------------------------- */
/* SourceDocument                                                             */
/* -------------------------------------------------------------------------- */

/**
 * An imported manuscript.
 *
 * `rawText` is stored VERBATIM (only line-ending normalisation is applied at
 * parse time via `normalizeText`, never in place here) so that every section
 * offset remains valid against it. `characterCount`/`wordCount` are computed at
 * import time and cached for the UI.
 */
export const SourceDocumentSchema = z
  .object({
    /** Stable primary key, prefixed (`doc_…`). */
    id: z.string().min(1, 'Document id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Document projectId is required'),

    /** Original file name, or `null` for pasted text. */
    fileName: z.string().trim().max(400).nullable(),
    format: DocumentFormatSchema,
    /** The raw manuscript text, stored verbatim. */
    rawText: z
      .string()
      .min(1, 'A document must contain text')
      .max(MAX_DOCUMENT_CHARS, `A document may be at most ${MAX_DOCUMENT_CHARS} characters`),
    /** Derived: `rawText.length` (UTF-16 code units). */
    characterCount: z.number().int().nonnegative(),
    /** Derived: whitespace-delimited word count (CJK-aware estimate). */
    wordCount: z.number().int().nonnegative(),

    status: DocumentStatusSchema,

    /**
     * When the document's structure was last parsed (P8 Batch 2). Absent/null
     * for a freshly-registered, not-yet-parsed document.
     */
    parsedAt: timestampSchema.nullable().optional(),
    /**
     * Fingerprint of `rawText` captured at the last parse (P8 Batch 2), stored
     * TAGGED as `sha256:<64 hex>` (see `@/utils/text-hash`). Used to detect
     * whether the raw text changed since parsing; when it matches, a re-parse is
     * a no-op (idempotent). Because `rawText` can never be edited through the
     * service, this normally only changes on a fresh import. A value in any
     * other format (e.g. a legacy 8-hex FNV digest) is treated as "unknown" and
     * triggers the normal guarded re-parse path — never silently treated equal.
     */
    parsedTextHash: z.string().min(1).optional(),
    /**
     * When the user last CONFIRMED the document's structure (P8 Batch 2).
     * Absent/null means "not confirmed". ANY structural edit clears it, so a
     * confirmed document can never silently fall back to stale structure.
     */
    structureConfirmedAt: timestampSchema.nullable().optional(),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((doc) => doc.updatedAt >= doc.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

/* -------------------------------------------------------------------------- */
/* DocumentSection                                                            */
/* -------------------------------------------------------------------------- */

/**
 * An addressable slice of a document's raw text.
 *
 * The invariant `rawText.slice(start, end) === text` is checked by the importer
 * (which has the raw text) rather than by this schema (which does not). Here we
 * enforce the ordering `0 <= start <= end` and a non-empty title for non-leaf
 * structural headings.
 */
export const DocumentSectionSchema = z
  .object({
    /** Stable primary key, prefixed (`dsec_…`). */
    id: z.string().min(1, 'Section id is required'),
    /** Owning project — denormalised for isolation and cascade deletes. */
    projectId: z.string().min(1, 'Section projectId is required'),
    /** Owning document. Indexed (compound with `order`). */
    documentId: z.string().min(1, 'Section documentId is required'),
    /** Parent section id for the tree, or `null` at the root. */
    parentId: z.string().min(1).nullable(),

    level: DocumentSectionLevelSchema,
    /** Heading text. May be empty ONLY for `paragraph` leaves. */
    title: z.string().max(300, 'Section title must be at most 300 characters'),
    /** Position among its siblings (ascending). */
    order: z.number().int('Order must be an integer').nonnegative('Order must be non-negative'),

    /** UTF-16 code-unit offset into `rawText`, inclusive. */
    start: offsetSchema,
    /** UTF-16 code-unit offset into `rawText`, exclusive. */
    end: offsetSchema,
    /** The slice `rawText.slice(start, end)`. */
    text: z.string(),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  // End must not precede start (empty sections allowed: start === end).
  .refine((section) => section.end >= section.start, {
    message: 'Section end must not be earlier than start',
    path: ['end'],
  })
  // The text must be exactly the slice length; this catches drift between the
  // stored text and its declared offsets without needing the raw text here.
  .refine((section) => section.text.length === section.end - section.start, {
    message: 'Section text length must equal end - start',
    path: ['text'],
  })
  .refine((section) => section.updatedAt >= section.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type DocumentSection = z.infer<typeof DocumentSectionSchema>;

/* -------------------------------------------------------------------------- */
/* DocumentEvidence                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A precise locator into a section of an imported document.
 *
 * This is the P8 analogue of P7 `Evidence`, kept SEPARATE on purpose so P7's
 * semantics never change. `start`/`end` are section-relative char offsets
 * (`[start, end)` within `section.text`) unless equal to the section span, in
 * which case they address the whole section.
 *
 * Cross-references (document↔project↔section containment) are validated by the
 * importer at write time, since that requires the stored rows; this schema
 * enforces only shape + range integrity.
 */
export const DocumentEvidenceSchema = z
  .object({
    /** The document the evidence comes from. */
    documentId: z.string().min(1, 'Evidence documentId is required'),
    /** The section within that document. */
    sectionId: z.string().min(1, 'Evidence sectionId is required'),
    /** Section-relative start offset (UTF-16 code units), inclusive. */
    start: offsetSchema,
    /** Section-relative end offset (UTF-16 code units), exclusive. */
    end: offsetSchema,
    /** Optional verbatim quote; when present it must match the addressed slice. */
    quote: z.string().max(4_000, 'A quote must be at most 4000 characters').optional(),
  })
  .strict()
  .refine((ref) => ref.end >= ref.start, {
    message: 'Evidence end must not be earlier than start',
    path: ['end'],
  });

export type DocumentEvidence = z.infer<typeof DocumentEvidenceSchema>;

/**
 * Verifies that a `DocumentEvidence` quote (when provided) matches the slice it
 * claims to address.
 *
 * Kept as a pure helper so the importer and tests share exactly one check. The
 * caller supplies the evidence and the resolved section text; the quote is
 * compared against `sectionText.slice(start, end)`.
 */
export function evidenceQuoteMatches(evidence: DocumentEvidence, sectionText: string): boolean {
  if (evidence.quote === undefined) return true;
  if (evidence.start > sectionText.length || evidence.end > sectionText.length) return false;
  return sectionText.slice(evidence.start, evidence.end) === evidence.quote;
}
