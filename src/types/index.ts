/**
 * Barrel for domain types.
 *
 * Only entities that actually exist are exported. New entities (Chapter,
 * Character, Location, …) are added here in the phase that introduces their
 * schema — never stubbed ahead of time.
 */
export type { ProjectStatus, ProjectSettings, NovelProject } from './project';
export { PROJECT_STATUSES } from './project';
export type { World, WorldSection } from './world';
export type { Character, CharacterRole, CharacterStatus } from './character';
export { CHARACTER_ROLES, CHARACTER_STATUSES } from './character';
export type {
  NarrativePlan,
  PlotBeat,
  NarrativeStructure,
  NarrativeStatus,
} from './narrative';
export { NARRATIVE_STRUCTURES, NARRATIVE_STATUSES } from '@/schemas/narrative';
export type { Chapter, Volume, ChapterStatus } from './outline';
export { CHAPTER_STATUSES } from '@/schemas/outline';
export type { Scene, SceneStatus, ScenePurpose } from './scene';
export { SCENE_STATUSES, SCENE_PURPOSES } from '@/schemas/scene';
export type { ChapterDraft, SceneDraft, Draft, DraftVersion, DraftKind, DraftVersionReason } from './manuscript';
export { DRAFT_KINDS, DRAFT_VERSION_REASONS, MAX_DRAFT_CHARS, MAX_VERSIONS_PER_DRAFT } from './manuscript';
export type {
  AiProvider,
  AiModel,
  AiTaskConfig,
  AiGlobalConfig,
  AiProviderType,
  AiTaskKind,
  AiCustomHeader,
} from '@/schemas/ai';
export {
  AI_PROVIDER_TYPES,
  AI_TASK_KINDS,
  AiProviderTypeSchema,
  AiTaskKindSchema,
  GLOBAL_AI_CONFIG_ID,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
} from '@/schemas/ai';
export type {
  AiMessage,
  AiGenerationParams,
  AiGenerationResult,
  AiRequestContext,
  AiHttpRequest,
  AiErrorKind,
  AiConfigValidation,
} from './ai';

/* ------------------------------ P6 — Prompt & Context ---------------------- */
export type {
  PromptTemplate,
  PromptTemplateVersion,
  PromptVariable,
  PromptBundle,
  PromptBundleEntry,
  PromptCategoryPreset,
} from '@/schemas/prompt';
export {
  PROMPT_CATEGORY_PRESETS,
  PROMPT_BUNDLE_FORMAT,
  PROMPT_BUNDLE_VERSION,
  VARIABLE_NAME_PATTERN,
} from '@/schemas/prompt';
export type {
  ContextLayer,
  ContextSourceType,
  ContextPriority,
  ContextItem,
  ContextConfig,
} from '@/schemas/context';
export {
  CONTEXT_LAYERS,
  CONTEXT_SOURCE_TYPES,
  CONTEXT_PRIORITIES,
  MIN_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_BUDGET_TOKENS,
  DEFAULT_REQUESTED_OUTPUT_TOKENS,
} from '@/schemas/context';

/* ------------------------ P7 — Knowledge & Analysis ----------------------- */
export type {
  KnowledgeEntry,
  KnowledgeEntryKind,
  KnowledgeSource,
  KnowledgeSourceRef,
  Evidence,
} from '@/types/knowledge';
export {
  KNOWLEDGE_ENTRY_KINDS,
  KNOWLEDGE_SOURCES,
  buildSourceKey,
  deriveSearchText,
} from '@/schemas/knowledge';
export type {
  ContinuityFact,
  ContinuitySubjectType,
  ContinuityPredicate,
  ReconstructedStateValue,
  LiveRankLookup,
} from '@/types/continuity';
export {
  CONTINUITY_SUBJECT_TYPES,
  CONTINUITY_PREDICATES,
  compareFacts,
  reconstructState,
  stateKey,
} from '@/schemas/continuity';
export type {
  AnalysisFinding,
  AnalysisCategory,
  AnalysisSeverity,
  AnalysisStatus,
  AnalysisOrigin,
} from '@/types/analysis';
export {
  ANALYSIS_CATEGORIES,
  ANALYSIS_SEVERITIES,
  ANALYSIS_STATUSES,
  ANALYSIS_ORIGINS,
} from '@/schemas/analysis';

/* --------------------------- P8 — Import & Extraction --------------------- */
export type {
  SourceDocument,
  DocumentSection,
  DocumentEvidence,
  DocumentFormat,
  DocumentStatus,
  DocumentSectionLevel,
} from '@/types/document';
export {
  DOCUMENT_FORMATS,
  DOCUMENT_STATUSES,
  DOCUMENT_SECTION_LEVELS,
  MAX_DOCUMENT_CHARS,
  evidenceQuoteMatches,
} from '@/schemas/document';
export type {
  ExtractionRecord,
  ExtractionKind,
  ExtractionOrigin,
  ExtractionReviewStatus,
  ExtractionIntegration,
  IntegrationStatus,
  IntegrationTargetType,
  IntegrationConflict,
} from '@/types/extraction';
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

