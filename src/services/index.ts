import { ProjectService } from './project-service';
import { WorldService } from './world-service';
import { CharacterService } from './character-service';
import { NarrativeService } from './narrative-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';
import { ManuscriptService } from './manuscript-service';
import { ManuscriptTransferService } from './manuscript-transfer-service';
import { AiService } from './ai-service';
import { AiConfigService } from './ai-config-service';
import { AiAssistanceService } from './ai-assistance-service';
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
