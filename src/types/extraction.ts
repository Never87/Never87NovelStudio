/**
 * Information-extraction domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/extraction` via `z.infer`.
 */
export type {
  ExtractionRecord,
  ExtractionKind,
  ExtractionOrigin,
  ExtractionReviewStatus,
  ExtractionIntegration,
  IntegrationStatus,
  IntegrationTargetType,
  IntegrationConflict,
} from '@/schemas/extraction';
export {
  EXTRACTION_KINDS,
  EXTRACTION_ORIGINS,
  EXTRACTION_REVIEW_STATUSES,
  INTEGRATION_STATUSES,
  INTEGRATION_TARGET_TYPES,
  buildDedupeKey,
  normaliseForKey,
  MAX_EXTRACTION_BODY_CHARS,
} from '@/schemas/extraction';
