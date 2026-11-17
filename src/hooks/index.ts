/**
 * React data hooks.
 *
 * Thin adapters between React state and the singleton Services. They never
 * touch Dexie, never re-implement business rules, and never store domain data
 * in Zustand.
 */
export { useProjects } from './use-projects';
export type { UseProjectsOptions, UseProjectsResult } from './use-projects';
export { useProject } from './use-project';
export type { ProjectLoadStatus, UseProjectResult } from './use-project';
export { useWorld } from './use-world';
export type { WorldLoadStatus, UseWorldResult } from './use-world';
export { useNarrative } from './use-narrative';
export type { NarrativeLoadStatus, UseNarrativeResult } from './use-narrative';
export { useOutline } from './use-outline';
export type { OutlineLoadStatus, UseOutlineResult } from './use-outline';
export { useBeatLinks } from './use-beat-links';
export type { UseBeatLinksResult } from './use-beat-links';
export { useScenes } from './use-scenes';
export type { SceneLoadStatus, UseScenesResult } from './use-scenes';
export { useCharacters } from './use-characters';
export type { UseCharactersResult } from './use-characters';
export { useAiConfig } from './use-ai-config';
export type { UseAiConfigResult, AiConfigStatus } from './use-ai-config';
export { useAiAssistance } from './use-ai-assistance';
export type { UseAiAssistanceResult, AiRunStatus } from './use-ai-assistance';
export { usePromptTemplates } from './use-prompt-templates';
export type { UsePromptTemplatesResult, PromptStatus } from './use-prompt-templates';
export { useContextManager } from './use-context-manager';
export type { UseContextManagerResult, ContextStatus } from './use-context-manager';
export { usePromptRequest } from './use-prompt-request';
export type { UsePromptRequestResult } from './use-prompt-request';
export { useKnowledgeBase } from './use-knowledge-base';
export type { UseKnowledgeBaseResult, KnowledgeStatus } from './use-knowledge-base';
export { useContinuity } from './use-continuity';
export type { UseContinuityResult, ContinuityStatus } from './use-continuity';
export { useAnalysis } from './use-analysis';
export type { UseAnalysisResult, AnalysisStatus } from './use-analysis';
export { useImportDocuments } from './use-import-documents';
export type { UseImportDocumentsResult, ImportDocumentsStatus } from './use-import-documents';
export { useExtractionReview } from './use-extraction-review';
export type { UseExtractionReviewResult, ReviewQueueStatus } from './use-extraction-review';
export { useExtraction } from './use-extraction';
export type { UseExtractionResult, ExtractionListStatus } from './use-extraction';
export { useIntegration } from './use-integration';
export type { UseIntegrationResult, IntegrationQueueStatus } from './use-integration';
export { usePublishingPresets } from './use-publishing-presets';
export type { UsePublishingPresetsResult } from './use-publishing-presets';
export { useCover } from './use-cover';
export type { UseCoverResult } from './use-cover';
export { useBlurb } from './use-blurb';
export type { UseBlurbResult, BlurbRunStatus } from './use-blurb';
export { usePortfolio } from './use-portfolio';
export type { UsePortfolioResult } from './use-portfolio';
export { useDashboardStats } from './use-dashboard-stats';
export type { UseDashboardStatsResult } from './use-dashboard-stats';
export { useWorkspaceStats } from './use-workspace-stats';
export type { UseWorkspaceStatsResult } from './use-workspace-stats';
export { useWritingGoal } from './use-writing-goal';
export type { UseWritingGoalResult } from './use-writing-goal';
export { useChapterLinks } from './use-chapter-links';
export type { UseChapterLinksResult, ChapterLinks, ChapterLinksStatus, LinkedEntity } from './use-chapter-links';
export { useChapterAnalysis } from './use-chapter-analysis';
export type { UseChapterAnalysisResult, ChapterAnalysisStatus } from './use-chapter-analysis';


