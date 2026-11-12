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
export { useScenes } from './use-scenes';
export type { SceneLoadStatus, UseScenesResult } from './use-scenes';
export { useCharacters } from './use-characters';
export type { UseCharactersResult } from './use-characters';
export { useAiConfig } from './use-ai-config';
export type { UseAiConfigResult, AiConfigStatus } from './use-ai-config';
export { useAiAssistance } from './use-ai-assistance';
export type { UseAiAssistanceResult, AiRunStatus } from './use-ai-assistance';
