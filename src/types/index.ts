/**
 * Barrel for domain types.
 *
 * Only entities that actually exist are exported. New entities (Chapter,
 * Character, Location, …) are added here in the phase that introduces their
 * schema — never stubbed ahead of time.
 */
export type { ProjectStatus, ProjectSettings, NovelProject } from './project';
export { PROJECT_STATUSES } from './project';
