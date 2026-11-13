/**
 * Bundling entry for P8 Batch-4 verification (Extraction Review Center).
 *
 * Re-exports the modules the batch-4 script exercises: the schemas, the shared
 * evidence-resolution utilities, `ImportRepository`, `ImportService`,
 * `ExtractionService` (to seed review-pending records) and the `ReviewService`
 * under test — all constructed in the script against an in-memory fake database
 * (no IndexedDB / network). The `@/` alias is supplied by the bundler.
 */
export {
  ExtractionRecordSchema,
  EXTRACTION_KINDS,
  EXTRACTION_ORIGINS,
  EXTRACTION_REVIEW_STATUSES,
  buildDedupeKey,
} from '../../src/schemas/extraction';
export {
  SourceDocumentSchema,
  DocumentSectionSchema,
  DocumentEvidenceSchema,
} from '../../src/schemas/document';
export { resolveEvidenceInSection, resolveEvidenceInDocument } from '../../src/utils/evidence-resolution';
export { ImportRepository } from '../../src/repositories/import-repository';
export { ProjectRepositoryError, ProjectValidationError } from '../../src/repositories/project-repository';
export {
  ImportService,
  ImportServiceError,
  ImportNotFoundError,
} from '../../src/services/import-service';
export {
  ExtractionService,
  ExtractionServiceError,
  ExtractionNotFoundError,
  ExtractionValidationError,
} from '../../src/services/extraction-service';
export {
  ReviewService,
  ReviewServiceError,
  ReviewNotFoundError,
  ReviewValidationError,
  evidenceStillValid,
  dedupeEvidence,
} from '../../src/services/review-service';
