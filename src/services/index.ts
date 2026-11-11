import { ProjectService } from './project-service';

/**
 * Module-level application Service.
 *
 * A single `ProjectService` instance is created here and shared by every hook,
 * so the (single) Dexie database behind it is reused instead of being rebuilt
 * on each render. `ProjectService` already defaults to a `ProjectRepository`
 * bound to the singleton `db`, so no extra repository/database is constructed.
 *
 * Hooks import THIS instance — they never call `new ProjectService()`.
 */
export const projectService = new ProjectService();

export { ProjectService };
export type { CreateProjectInput, UpdateProjectInput } from './project-service';
export {
  ProjectServiceError,
  ProjectRepositoryError,
  ProjectValidationError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
} from './project-service';
