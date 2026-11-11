/**
 * Project domain types.
 *
 * These are re-exports only — every type originates from the Zod schemas in
 * `@/schemas/project` via `z.infer`. No interfaces are re-declared here, so
 * there is exactly one definition of each project shape in the codebase.
 */
export type { ProjectStatus, ProjectSettings, NovelProject } from '@/schemas/project';

/** Runtime list of valid statuses, for UI selects and validation. */
export { PROJECT_STATUSES } from '@/schemas/project';
