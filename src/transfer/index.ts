/**
 * Transfer foundation (P9 Batch 1) — public surface.
 *
 * Reusable, UI-independent building blocks for future project snapshots,
 * `.n87novel` import/export and workspace backup/restore:
 *
 *   - `TRANSFER_COLLECTIONS` / `EXCLUDED_TABLES` — the table inventory.
 *   - `TransferService`                           — export / parse / remap.
 *   - `validateTransferPackage`                   — pure, structured validation.
 *   - `computeIntegrity` / `canonicalStringify`   — deterministic hashing.
 *   - `buildIdMap` / `remapProject`               — ID-mapping foundation.
 *
 * Nothing here renders UI, and nothing here writes to the database.
 */

export {
  TRANSFER_COLLECTIONS,
  TRANSFER_COLLECTION_KEYS,
  TRANSFER_COLLECTION_COUNT,
  EXCLUDED_TABLES,
  SECRET_BEARING_TABLES,
  type TransferCollection,
} from '@/transfer/collection-registry';

export {
  canonicalStringify,
  computeIntegrity,
  verifyIntegrity,
  CanonicalJsonError,
} from '@/transfer/canonical-json';

export {
  validateTransferPackage,
  TRANSFER_PROBLEM_CODES,
  TRANSFER_REFERENCE_RULES,
  type TransferProblem,
  type TransferProblemCode,
  type TransferValidationResult,
} from '@/transfer/validation';

export {
  buildIdMap,
  remapProject,
  findAmbiguousIds,
  defaultIdFactory,
  AmbiguousIdMapError,
  PROJECT_COLLECTION,
  type IdMap,
  type IdFactory,
  type RemapResult,
  type UnresolvedReference,
} from '@/transfer/id-mapping';

export { TransferRepositoryAdapter, type ProjectDataSnapshot } from '@/transfer/transfer-repository-adapter';

export {
  TransferService,
  TransferExportError,
  TransferSerializationError,
  type ExportOptions,
  type ParseResult,
  type TransferFormatDescription,
} from '@/transfer/transfer-service';

export {
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_SCHEMA_VERSION,
  TRANSFER_PACKAGE_KINDS,
  TransferPackageSchema,
  type TransferPackage,
  type TransferProject,
  type TransferProjectData,
  type TransferMetadata,
  type TransferIntegrity,
  type TransferPackageKind,
} from '@/schemas/transfer';
