/**
 * Bundling entry for P8 Batch-5 verification (Project Integration).
 *
 * Re-exports the modules the batch-5 scripts exercise: the schemas, the shared
 * evidence-resolution utilities, the repositories, `ImportService` /
 * `ExtractionService` / `ReviewService` (to seed confirmed records) and the
 * `IntegrationService` under test. The in-memory fake-db script
 * (`p8-integration-verify.cjs`) builds services against fake tables; the
 * REAL-IndexedDB harness imports the live singleton services + db directly.
 */
export {
  ExtractionRecordSchema,
  EXTRACTION_KINDS,
  EXTRACTION_ORIGINS,
  EXTRACTION_REVIEW_STATUSES,
  INTEGRATION_STATUSES,
  INTEGRATION_TARGET_TYPES,
  buildDedupeKey,
} from '../../src/schemas/extraction';
export {
  SourceDocumentSchema,
  DocumentSectionSchema,
  DocumentEvidenceSchema,
} from '../../src/schemas/document';
export { KnowledgeEntrySchema, EvidenceSchema, EvidenceSourceSchema } from '../../src/schemas/knowledge';
export { CharacterSchema } from '../../src/schemas/character';
export { WorldSchema } from '../../src/schemas/world';
export { resolveEvidenceInSection, resolveEvidenceInDocument } from '../../src/utils/evidence-resolution';
export { ImportRepository } from '../../src/repositories/import-repository';
export { KnowledgeRepository } from '../../src/repositories/knowledge-repository';
export { CharacterRepository } from '../../src/repositories/character-repository';
export { WorldRepository } from '../../src/repositories/world-repository';
export { ProjectRepositoryError, ProjectValidationError } from '../../src/repositories/project-repository';
export { NovelStudioDb, getDb } from '../../src/db';
export { ImportService, ImportServiceError, ImportNotFoundError } from '../../src/services/import-service';
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
export {
  IntegrationService,
  IntegrationServiceError,
  IntegrationNotFoundError,
  IntegrationValidationError,
  knowledgeKindFor,
} from '../../src/services/integration-service';
