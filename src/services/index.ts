import { ProjectService } from './project-service';
import { WorldService } from './world-service';
import { CharacterService } from './character-service';
import { NarrativeService } from './narrative-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';
import { ManuscriptService } from './manuscript-service';
import { ManuscriptHistoryService } from './manuscript-history-service';
import { ManuscriptTransferService } from './manuscript-transfer-service';
import { AiService } from './ai-service';
import { AiConfigService } from './ai-config-service';
import { AiAssistanceService } from './ai-assistance-service';
import { BlurbService } from './blurb-service';
import { PromptTemplateService } from './prompt-template-service';
import { ContextManagerService } from './context-manager-service';
import { ContextAssemblyService } from './context-assembly-service';
import { KnowledgeService } from './knowledge-service';
import { ContinuityService } from './continuity-service';
import { AnalysisService } from './analysis-service';
import { ImportService } from './import-service';
import { ExtractionService } from './extraction-service';

import { ReviewService } from './review-service';
import { IntegrationService } from './integration-service';
import { SnapshotService } from './snapshot-service';
import { BackupService } from './backup-service';
import { BackupPreviewService } from './backup-preview-service';
import { ProjectRestoreService } from './project-restore-service';
import { BookAssemblyService } from './book-assembly-service';
import { coverService } from './cover-service';
import { PortfolioService } from './portfolio-service';

/**
 * Module-level application Services.
 *
 * Single instances are created here and shared by every hook, so the (single)
 * Dexie database behind them is reused instead of being rebuilt on each
 * render. Each Service already defaults to a Repository bound to the singleton
 * `db`, so no extra repository/database is constructed.
 *
 * Hooks import THESE instances — they never call `new XService()`.
 */
export const projectService = new ProjectService();
export const worldService = new WorldService();
export const characterService = new CharacterService();
export const narrativeService = new NarrativeService();
export const outlineService = new OutlineService();
export const sceneService = new SceneService();
export const manuscriptService = new ManuscriptService();
export const manuscriptHistoryService = new ManuscriptHistoryService();
export const manuscriptTransferService = new ManuscriptTransferService();

/**
 * AI services (P5).
 *
 * `aiService` is the single runtime entry point for generation; the assistance
 * service wraps it with task prompts and proposal packaging. `aiConfigService`
 * owns provider/model/task configuration and is used by the settings hooks.
 */
export const aiService = new AiService();
export const aiConfigService = new AiConfigService();
export const aiAssistanceService = new AiAssistanceService(aiService);
/** Blurb Generator service (P9 Batch D) — shares the single `aiService`. */
export const blurbService = new BlurbService(aiService);

/**
 * Prompt Engineering Center & Context Manager services (P6).
 *
 * `promptTemplateService` owns editable templates + versioning;
 * `contextManager` owns the per-project context config/items; and
 * `contextAssemblyService` is the SINGLE logical request builder shared by the
 * preview and the execution path. `aiAssistanceService` runs assembled requests.
 */
export const promptTemplateService = new PromptTemplateService();
export const contextManagerService = new ContextManagerService();
export const contextAssemblyService = new ContextAssemblyService({ aiService });

/**
 * Knowledge Base, Continuity & Story Analysis services (P7).
 *
 * `knowledgeService` indexes/search existing project entities;
 * `continuityService` owns the event-sourced fact log and point-in-time
 * reconstruction; `analysisService` runs deterministic detectors (and exposes
 * optional, explicit AI-assisted proposals) producing evidence-backed findings.
 */
export const knowledgeService = new KnowledgeService();
export const continuityService = new ContinuityService();
export const analysisService = new AnalysisService();

/**
 * Import pipeline service (P8 Batch 2).
 *
 * Owns the source-document lifecycle (register → parse → confirm) and structure
 * editing over `DocumentSection`. Defaults to a repository bound to the same
 * singleton `db`, so it shares the one IndexedDB instance with every other
 * service and hook.
 */
export const importService = new ImportService();

/**
 * Information-extraction service (P8 Batch 3).
 *
 * Turns a document's CONFIRMED structure into review-pending `ExtractionRecord`s,
 * either manually or through the P5 AI pipeline (`aiService.generate`, lazily
 * resolved). Reuses the shared `importService` so confirmed-section gating and
 * project scoping are identical to the import batch. It never writes project
 * entities — integration is a separate, user-reviewed step.
 */
export const extractionService = new ExtractionService({ importService });

/**
 * Extraction Review Center service (P8 Batch 4).
 *
 * Owns the REVIEW LIFECYCLE (edit pending → confirm / reject / restore / merge)
 * of the review-pending `ExtractionRecord`s produced by `extractionService`. It
 * composes the shared `importService` and `extractionService` so evidence
 * re-resolution and confirmed-structure gating are identical to the extraction
 * batch, and it never writes project entities. A "merge" folds a duplicate
 * extraction into another EXTRACTION RECORD (not into a project entity).
 */
export const reviewService = new ReviewService({ importService, extractionService });
/**
 * Project Integration service (P8 Batch 5).
 *
 * The ONLY phase that turns CONFIRMED `ExtractionRecord`s into real project
 * entities (Character / World section / KnowledgeEntry). It composes the shared
 * `importService` so evidence re-validation is identical to the review batch,
 * and it never touches a record that has not been explicitly confirmed. Every
 * write runs inside a single Dexie transaction spanning the import tables and
 * the target entity table, so an entity can never be written without its record
 * being stamped `applied`.
 */
export const integrationService = new IntegrationService({ importService });

/**
 * Project Snapshots service (P9 Batch 3-2).
 *
 * Business layer over `SnapshotRepository` + the P9 B1 transfer foundation:
 * captures a project's COMPLETE state as an immutable `ProjectSnapshot` and
 * restores one ATOMICALLY (pre-restore safety snapshot + single 21-store
 * readwrite transaction). Pure service — NO UI, routes, hooks or editor
 * coordination live here; a future restore UI must follow `RESTORE_UI_LIFECYCLE`
 * (flush editors before, reload project/editor state after). Defaults to the
 * singleton `db` via each dependency's own default.
 */
export const projectSnapshotService = new SnapshotService();

/**
 * Project Backup service (P9 Batch 4-1).
 *
 * Thin file-export layer over the P9 B1 transfer foundation: serialises ONE
 * project to a canonical `.n87novel` file (all 19 project-owned collections,
 * never secrets) for download. It reuses B1 for serialisation, validation,
 * integrity and collection selection, never WRITES project data, and does not
 * support workspace export. Restoring a backup file is a later batch.
 */
export const backupService = new BackupService();

/**
 * Project Backup PREVIEW service (P9 Batch 4-2).
 *
 * READ-ONLY companion to `backupService`. Parses + validates a user-selected
 * `.n87novel` file through the P9 B1 transfer foundation and returns a typed
 * preview (metadata + all 19 collection counts + integrity + whether the source
 * project already exists locally). It never writes, never repairs an invalid
 * file, rejects workspace packages, and never exposes the raw payload. Restoring
 * a backup is a LATER batch — this service only inspects files.
 */
export const backupPreviewService = new BackupPreviewService();

/**
 * Project Backup RESTORE service (P9 Batch 4-3).
 *
 * The only writer of restored backup data. Turns a VALIDATED `.n87novel` entry
 * into project data in one of two explicit modes:
 *   - `restoreAsNewProject` — fresh project id, full id remap, atomic insert;
 *   - `replaceExistingProject` — explicit target id, pre-restore safety snapshot
 *     then atomic owner-scoped replacement.
 * Reuses B1 (validate/integrity/id-remap) and B3 (safety snapshot); never
 * re-implements a transfer format or duplicates validation. It re-validates the
 * payload before writing (a stale preview is never authorisation). Pure service:
 * the UI must flush/reload editors around it (see `BACKUP_RESTORE_UI_LIFECYCLE`).
 */
export const projectRestoreService = new ProjectRestoreService();

/**
 * Book Assembly service (P9 Batch A — Publishing Foundation).
 *
 * READ-ONLY assembler that builds the `BookAssemblyModel` consumed by the
 * shared publishing pipeline (`FormattingPipeline` + presets → `RenderedDocument`
 * → TXT/Markdown/HTML writers). It retrieves data through the existing
 * `OutlineService` (canonical volume/chapter order), `ManuscriptService`
 * (`ChapterDraft` prose, the AUTHORITATIVE chapter body) and `SceneService`
 * (scene COUNTS only — scene prose is never concatenated into a chapter). It
 * performs NO writes, saves, snapshots or mutations, and is project-scoped.
 */
export const bookAssemblyService = new BookAssemblyService();

/**
 * Book Covers service (P9 Batch D).
 *
 * Business layer over stored cover-image resources: validates an uploaded image
 * (PNG/JPEG/WebP, size + dimension limits), stores its bytes as a Blob in the
 * `coverAssets` table, and points the project at it via the short
 * `cover: "asset:<id>"` reference (updated through `ProjectService`). Superseded
 * assets are cleaned up. It also resolves a project's CURRENT cover for display
 * and as bytes for the EPUB/PDF writers — degrading gracefully to a placeholder
 * when an `asset:` reference has no matching asset on this device (e.g. after an
 * import, since cover binaries are device-local and excluded from the JSON
 * transfer payload).
 */

export { coverService };

/**
 * Portfolio service (P9 Batch E).
 *
 * Business layer for the author's curated catalog. Joins project rows with
 * optional `PortfolioProfile` DISPLAY overrides into resolved `PortfolioEntry`
 * objects and upserts/removes profiles. It never duplicates the project's
 * description/blurb/cover/genre/status (those are read live) and never touches
 * `NovelProject.description` or `NovelProject.blurb`.
 */
export const portfolioService = new PortfolioService();

export { ProjectService };
export type { CreateProjectInput, UpdateProjectInput } from './project-service';
export { WorldService };
export type { CreateWorldInput, UpdateWorldInput } from './world-service';
export { CharacterService };
export type { CreateCharacterInput, UpdateCharacterInput } from './character-service';
export { NarrativeService };
export {
  NarrativeAlreadyExistsError,
  NarrativeNotFoundError,
  NarrativeServiceError,
} from './narrative-service';
export type {
  CreateNarrativeInput,
  UpdateNarrativeInput,
  PlotBeatInput,
} from './narrative-service';
export { OutlineService, OutlineNotFoundError } from './outline-service';
export type {
  VolumeWithChapters,
  CreateVolumeInput,
  UpdateVolumeInput,
  CreateChapterInput,
  UpdateChapterInput,
} from './outline-service';
export { SceneService } from './scene-service';
export {
  ManuscriptService,
  DraftConflictError,
  ChapterLockedError,
} from './manuscript-service';
export { ManuscriptHistoryService } from './manuscript-history-service';
export type {
  ManuscriptHistoryEntry,
  ProjectHistory,
} from './manuscript-history-service';
export { ManuscriptTransferService } from './manuscript-transfer-service';
export type {
  ImportPreviewChapter,
  ImportResult,
  ImportOptions,
} from './manuscript-transfer-service';
export type {
  ChapterEditorDocument,
  SaveDraftInput,
  SaveDraftResult,
  RestoreVersionResult,
  CreateDraftOptions,
} from './manuscript-service';
export type { CreateSceneInput, UpdateSceneInput } from './scene-service';
export {
  ProjectServiceError,
  ProjectRepositoryError,
  ProjectValidationError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
} from './project-service';

/* ------------------------------- AI (P5) --------------------------------- */

export {
  AiConfigService,
  AiConfigError,
  AiConfigNotFoundError,
} from './ai-config-service';
export type {
  CreateProviderInput,
  UpdateProviderInput,
  CreateModelInput,
  UpdateModelInput,
} from './ai-config-service';
export { AiService } from './ai-service';
export type { ResolvedAiTarget, GenerateOptions, AiServiceDeps } from './ai-service';
export { AiAssistanceService, AiAssistanceError, ANCHOR_CONTEXT_CHARS } from './ai-assistance-service';
export type { AiProposal, RunAssistanceInput, InsertAnchor } from './ai-assistance-service';
export { AiError, isAiError } from './ai/ai-errors';
export { AiTransport } from './ai/ai-transport';
export { ProviderAdapter } from './ai/provider-adapter';
export { getAdapter, supportedProviderTypes } from './ai/adapter-registry';
export { TASK_PROMPTS, TASK_PROMPT_LIST } from './ai/task-prompts';
export type { TaskPromptDefinition, TaskPromptInput } from './ai/task-prompts';
export { diffWords, isIdentical } from './ai/text-diff';
export type { DiffToken, DiffOp } from './ai/text-diff';
export { redactSecrets, maskApiKey, redactKnownPatterns, redactForError } from './ai/redaction';

/* -------------------------- Prompt & Context (P6) ------------------------ */

export { PromptTemplateService, PromptTemplateError } from './prompt-template-service';
export type {
  CreateTemplateInput,
  UpdateTemplateInput,
  PromptImportResult,
} from './prompt-template-service';
export { ContextManagerService, ContextManagerError, isReferenceSource } from './context-manager-service';
export type {
  CreateContextItemInput,
  UpdateContextItemInput,
  UpdateContextConfigInput,
} from './context-manager-service';
export { ContextAssemblyService, ContextAssemblyError } from './context-assembly-service';
export type {
  AssembledRequest,
  AssembledSection,
  ContextNotice,
  AssemblyInput,
} from './context-assembly-service';
export { renderTemplate, parsePlaceholders, validateTemplate, referencedVariableNames, normalizeValues, PromptRenderError } from './ai/prompt-render';
export type { ParsedPlaceholder, RenderResult, TemplateValidationIssue } from './ai/prompt-render';
export { estimateTokens, estimateMessagesTokens } from './ai/token-estimator';
export { BUILTIN_TEMPLATES } from './ai/builtin-templates';
export type { BuiltinTemplate } from './ai/builtin-templates';

/* ------------------------ Knowledge & Analysis (P7) ---------------------- */

export { KnowledgeService } from './knowledge-service';
export type {
  CreateKnowledgeInput,
  UpdateKnowledgeInput,
  ImportKnowledgeResult,
  KnowledgeSearchResult,
} from './knowledge-service';
export { ContinuityService } from './continuity-service';
export type {
  CreateContinuityFactInput,
  UpdateContinuityFactInput,
  SubjectState,
} from './continuity-service';
export { AnalysisService } from './analysis-service';
export type {
  FindingDraft,
  RunAnalysisResult,
  UpdateFindingInput,
} from './analysis-service';

/* ------------------------------ Import (P8) ------------------------------ */

export {
  ImportService,
  ImportServiceError,
  ImportNotFoundError,
  ImportConflictError,
  hashText,
} from './import-service';
export {
  hashRawText,
  sha256Hex,
  isCurrentHashFormat,
  HASH_ALGORITHM,
  HASH_PREFIX,
} from '@/utils/text-hash';
export type {
  CreateDocumentInput,
  UpdateSectionInput,
  ParseDocumentResult,
} from './import-service';

/* ---------------------------- Extraction (P8.3) -------------------------- */

export {
  ExtractionService,
  ExtractionServiceError,
  ExtractionNotFoundError,
  ExtractionValidationError,
  buildExtractionMessages,
  parseAiCandidates,
} from './extraction-service';
export type {
  CreateManualExtractionInput,
  UpdateExtractionInput,
  GenerateAiExtractionsInput,
  GenerateAiExtractionsResult,
  AiExtractionCandidate,
  EvidenceInput,
  GenerateFn,
} from './extraction-service';
export {
  resolveEvidenceInSection,
  resolveEvidenceInDocument,
  findOccurrences,
  toDocumentOffsets,
} from '@/utils/evidence-resolution';
export type {
  ResolveEvidenceResult,
  ResolveEvidenceOptions,
  EvidenceResolutionFailure,
} from '@/utils/evidence-resolution';

/* ------------------------- Review Center (P8.4) -------------------------- */

export {
  ReviewService,
  ReviewServiceError,
  ReviewNotFoundError,
  ReviewValidationError,
  evidenceStillValid,
  dedupeEvidence,
} from './review-service';
export type {
  ReviewQueueFilters,
  ReviewQueueItem,
  ReviewDetail,
  ReviewedEvidence,
  UpdatePendingInput,
  ReviewActionResult,
  MergeResult,
} from './review-service';

/* ----------------------- Project Integration (P8.5) ---------------------- */

export {
  IntegrationService,
  IntegrationServiceError,
  IntegrationNotFoundError,
  IntegrationValidationError,
  knowledgeKindFor,
} from './integration-service';
export type {
  IntegrationItemResult,
  IntegrationBatchResult,
  IntegrationTargetType,
  IntegrationPreview,
  PreviewFieldMapping,
  PreviewExistingMatch,
  PreviewPlan,
  PreviewEvidence,
  ApplyIntegrationInput,
} from './integration-service';
export type { ConflictStrategy, ConflictResolution } from '@/schemas/extraction';

/* --------------------------- Snapshots (P9.3) ---------------------------- */

export {
  SnapshotService,
  SnapshotServiceError,
  SNAPSHOT_ERROR_CODES,
  RESTORE_UI_LIFECYCLE,
  isQuotaError,
} from './snapshot-service';
export type {
  SnapshotErrorCode,
  SnapshotRestorePhase,
  CreateSnapshotOptions,
  RestoreSnapshotResult,
} from './snapshot-service';

/* --------------------------- Backup (P9.4) ------------------------------- */

export {
  BackupService,
  BackupServiceError,
  PROJECT_BACKUP_EXTENSION,
  PROJECT_BACKUP_MIME,
  sanitizeBackupFileNameSegment,
  buildBackupFileName,
} from './backup-service';
export type { ProjectBackupFile } from './backup-service';

/* ------------------------- Backup Preview (P9.4-2) ---------------------- */

export {
  BackupPreviewService,
  BackupImportError,
  MAX_BACKUP_FILE_BYTES,
} from './backup-preview-service';
export type {
  BackupImportErrorCode,
  BackupPreview,
  BackupCollectionCount,
  BackupPreviewInput,
  PreviewBackupOptions,
  ValidatedBackupEntry,
} from './backup-preview-service';

/* ------------------------- Backup Restore (P9.4-3) --------------------- */

export {
  ProjectRestoreService,
  ProjectRestoreError,
  PROJECT_RESTORE_ERROR_CODES,
  BACKUP_RESTORE_UI_LIFECYCLE,
} from './project-restore-service';
export type {
  ProjectRestoreErrorCode,
  ProjectRestorePhase,
  ProjectRestoreResult,
  ProjectRestoreOptions,
} from './project-restore-service';

/* ---------------------- Book Assembly (P9 Batch A) --------------------- */

export { BookAssemblyService, BookAssemblyError } from './book-assembly-service';
export type {
  AssembleOptions,
  BookAssemblyDeps,
} from './book-assembly-service';

/* ------------------- Full-Book Export (P9 Batch C) --------------------- */

export {
  exportFullBook,
  previewFullBook,
  downloadExport,
} from './full-book-export-service';
export type {
  FullBookExportResult,
  FullBookExportDeps,
  FullBookExportOptions,
  FullBookPreviewResult,
  FullBookPreviewDeps,
  ExportCoverInput,
} from './full-book-export-service';

/* ------------------------ Book Covers (P9 Batch D) -------------------- */

export {
  CoverService,
  CoverServiceError,
  COVER_ERROR_CODES,
  isCoverErrorCode,
} from './cover-service';
export type {
  CoverErrorCode,
  CoverResolution,
  CurrentCover,
  UploadCoverOptions,
  UploadCoverResult,
} from './cover-service';

/* ------------------------ Blurb Generator (P9 Batch D) ---------------- */

export { BlurbService, BlurbServiceError } from './blurb-service';
export type {
  BlurbProposal,
  GenerateBlurbInput,
  BlurbServiceDeps,
} from './blurb-service';
export type { BlurbLength, BlurbStyle, BlurbContext } from '@/modules/publishing/blurb/blurb-prompt';

/* --------------------------- Portfolio (P9 Batch E) ------------------- */

export { PortfolioService, PortfolioServiceError, PORTFOLIO_ERROR_CODES } from './portfolio-service';
export type { PortfolioErrorCode } from './portfolio-service';

