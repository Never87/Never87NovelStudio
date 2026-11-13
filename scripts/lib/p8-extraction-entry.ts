/**
 * Bundling entry for P8 Batch-3 verification (information extraction).
 *
 * Re-exports the modules the batch-3 script exercises: the pure evidence-
 * resolution utilities and the `ExtractionService` (constructed in the script
 * with an in-memory fake database + fake AI generator, so no IndexedDB / network
 * is used). The `@/` alias is supplied by the bundler's `resolve.alias`.
 */
export {
  ExtractionRecordSchema,
  EXTRACTION_KINDS,
  EXTRACTION_ORIGINS,
  EXTRACTION_REVIEW_STATUSES,
  buildDedupeKey,
  normaliseForKey,
  MAX_EXTRACTION_BODY_CHARS,
} from '../../src/schemas/extraction';
export {
  SourceDocumentSchema,
  DocumentSectionSchema,
  DocumentEvidenceSchema,
  evidenceQuoteMatches,
} from '../../src/schemas/document';
export {
  resolveEvidenceInSection,
  resolveEvidenceInDocument,
  findOccurrences,
  toDocumentOffsets,
} from '../../src/utils/evidence-resolution';
export { ImportRepository } from '../../src/repositories/import-repository';
export { ProjectRepositoryError, ProjectValidationError } from '../../src/repositories/project-repository';
export {
  ImportService,
  ImportServiceError,
  ImportNotFoundError,
  ImportConflictError,
  hashText,
} from '../../src/services/import-service';
export {
  ExtractionService,
  ExtractionServiceError,
  ExtractionNotFoundError,
  ExtractionValidationError,
  buildExtractionMessages,
  parseAiCandidates,
} from '../../src/services/extraction-service';
