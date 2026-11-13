/**
 * Import document domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/document` via `z.infer`.
 */
export type {
  SourceDocument,
  DocumentSection,
  DocumentEvidence,
  DocumentFormat,
  DocumentStatus,
  DocumentSectionLevel,
} from '@/schemas/document';
export {
  DOCUMENT_FORMATS,
  DOCUMENT_STATUSES,
  DOCUMENT_SECTION_LEVELS,
  MAX_DOCUMENT_CHARS,
  evidenceQuoteMatches,
} from '@/schemas/document';
