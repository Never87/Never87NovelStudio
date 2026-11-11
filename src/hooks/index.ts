/**
 * React data hooks.
 *
 * Thin adapters between React state and the singleton `ProjectService`.
 * They never touch Dexie, never re-implement business rules, and never store
 * domain data in Zustand.
 */
export { useProjects } from './use-projects';
export type { UseProjectsOptions, UseProjectsResult } from './use-projects';
export { useProject } from './use-project';
export type { ProjectLoadStatus, UseProjectResult } from './use-project';
