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

