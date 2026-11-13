/**
 * Bundling entry for P8 Batch-1 verification.
 *
 * Re-exports exactly the P8 modules the verification script exercises. Only
 * PURE / injectable modules are re-exported: `ImportRepository` is constructed
 * in the script with an in-memory fake database, so no IndexedDB is used.
 *
 * The `@/` alias is avoided inside the schemas (they import relatively); the
 * Repository uses `@/...` imports — the bundler's `root` is the project root,
 * so the alias resolves the same way it does for the app build.
 */
export {
  SourceDocumentSchema,
  DocumentSectionSchema,
  DocumentEvidenceSchema,
  evidenceQuoteMatches,
  DOCUMENT_FORMATS,
  DOCUMENT_STATUSES,
  DOCUMENT_SECTION_LEVELS,
  MAX_DOCUMENT_CHARS,
} from '../../src/schemas/document';
export {
  ExtractionRecordSchema,
  EXTRACTION_KINDS,
  EXTRACTION_ORIGINS,
  EXTRACTION_REVIEW_STATUSES,
  buildDedupeKey,
  normaliseForKey,
} from '../../src/schemas/extraction';
export {
  normalizeText,
  detectStructure,
  parseDocument,
  countWords,
  DocumentParseError,
} from '../../src/utils/document-parser';
export { ImportRepository } from '../../src/repositories/import-repository';
export { ProjectRepositoryError, ProjectValidationError } from '../../src/repositories/project-repository';
