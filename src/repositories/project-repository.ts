import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { NovelProjectSchema } from '@/schemas/project';
import type { NovelProject, ProjectStatus } from '@/types';

/**
 * Error raised by the Repository layer.
 *
 * Every instance keeps the original `cause` (a Dexie error, a ZodError, …) so
 * the UI can render diagnostics without the Repository having to know how to
 * present them. Errors are never swallowed into `null`/`false`.
 */
export class ProjectRepositoryError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProjectRepositoryError';
    this.cause = cause;
  }
}

/** Raised when `create()` is asked to insert an id that already exists. */
export class ProjectAlreadyExistsError extends ProjectRepositoryError {
  readonly projectId: string;

  constructor(projectId: string, cause?: unknown) {
    super(`Project "${projectId}" already exists`, cause);
    this.name = 'ProjectAlreadyExistsError';
    this.projectId = projectId;
  }
}

/** Raised when `update()` targets an id that does not exist. */
export class ProjectNotFoundError extends ProjectRepositoryError {
  readonly projectId: string;

  constructor(projectId: string, cause?: unknown) {
    super(`Project "${projectId}" was not found`, cause);
    this.name = 'ProjectNotFoundError';
    this.projectId = projectId;
  }
}

/** Raised when a project fails Zod validation before a write. */
export class ProjectValidationError extends ProjectRepositoryError {
  readonly issues: unknown;

  constructor(message: string, issues: unknown, cause?: unknown) {
    super(message, cause);
    this.name = 'ProjectValidationError';
    this.issues = issues;
  }
}

/**
 * Data-access layer for projects.
 *
 * Pure persistence concerns only: no default-value generation, no business
 * rules, no id or timestamp creation (that is the Service's job). Every write
 * is validated against `NovelProjectSchema` first.
 *
 * The database is injected so tests can substitute an isolated instance;
 * a new `NovelStudioDb` is never created here.
 */
export class ProjectRepository {
  private readonly table: Table<NovelProject, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.projects;
  }

  /**
   * Returns the project with `id`, or `null` when it does not exist.
   *
   * A record that exists but does not satisfy `NovelProjectSchema` is NEVER
   * returned as data and never mistaken for "not found": it throws a
   * `ProjectRepositoryError` whose `cause` is the original ZodError, so the
   * caller sees a diagnosable failure rather than a silently corrupted project.
   */
  async getById(id: string): Promise<NovelProject | null> {
    let project: NovelProject | undefined;
    try {
      project = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read project "${id}"`, error);
    }

    // A missing record keeps the existing contract (null).
    if (project === undefined) return null;

    // Present but malformed: surface it, do not pass it on.
    assertReadableProject(project, `Failed to read project "${id}"`);
    return project;
  }

  /**
   * All projects, newest `updatedAt` first.
   *
   * Every row is validated on read. One malformed record fails the whole
   * call (no silent filtering) so a corrupt row can never masquerade as an
   * empty-but-healthy list.
   */
  async getAll(): Promise<NovelProject[]> {
    let projects: NovelProject[];
    try {
      // Sorted by the index, then reversed — never rely on natural order.
      projects = await this.table.orderBy('updatedAt').reverse().toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list projects', error);
    }

    projects.forEach((project, index) =>
      assertReadableProject(project, `Failed to list projects (record at position ${index})`),
    );
    return projects;
  }

  /**
   * Projects with the given status, newest `updatedAt` first.
   *
   * Rows are validated on read, exactly like `getAll`. This method issues its
   * own query (it does not delegate to `getAll`), so there is no double parse.
   */
  async getByStatus(status: ProjectStatus): Promise<NovelProject[]> {
    let projects: NovelProject[];
    try {
      projects = await this.table.where('status').equals(status).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list projects with status "${status}"`, error);
    }

    projects.forEach((project, index) =>
      assertReadableProject(
        project,
        `Failed to list projects with status "${status}" (record at position ${index})`,
      ),
    );

    // Sort explicitly so the contract holds regardless of index layout and
    // never depends on the order IndexedDB happens to return.
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Inserts a new project.
   *
   * Uses `add()` (not `put()`), so an existing id is never silently
   * overwritten — the collision surfaces as `ProjectAlreadyExistsError`.
   * Returns the validated project that was written.
   */
  async create(project: NovelProject): Promise<NovelProject> {
    const validated = validateProject(project);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      if (isConstraintError(error)) {
        throw new ProjectAlreadyExistsError(project.id, error);
      }
      throw new ProjectRepositoryError(`Failed to create project "${project.id}"`, error);
    }
  }

  /**
   * Replaces an existing project.
   *
   * Fails with `ProjectNotFoundError` when the id does not exist, rather than
   * creating it. `put()` replaces the whole record, so fields removed by the
   * caller (e.g. an unset `cover`) do not linger from the previous version.
   * Returns the validated project that was written.
   */
  async update(project: NovelProject): Promise<NovelProject> {
    const validated = validateProject(project);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectNotFoundError(validated.id);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw error;
      throw new ProjectRepositoryError(`Failed to update project "${project.id}"`, error);
    }
  }

  /** Deletes a project. Fails when it does not exist. */
  async delete(id: string): Promise<void> {
    try {
      const existing = await this.table.get(id);
      if (!existing) {
        throw new ProjectNotFoundError(id);
      }
      await this.table.delete(id);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) throw error;
      throw new ProjectRepositoryError(`Failed to delete project "${id}"`, error);
    }
  }

  /** Whether a project with `id` exists. */
  async exists(id: string): Promise<boolean> {
    try {
      const count = await this.table.where(':id').equals(id).count();
      return count > 0;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to check existence of project "${id}"`, error);
    }
  }
}

/**
 * Guards a record READ from the database.
 *
 * Read-path counterpart to `validateProject`: it re-uses the same
 * `NovelProjectSchema` so a row that was written elsewhere (a previous schema
 * version, a tampered store, a bad import) can never re-enter the business
 * layer or the UI unchecked. Unlike the write path this does not replace the
 * caller's object — the Dexie record is returned as-is — it only verifies it.
 *
 * On failure it throws `ProjectRepositoryError` (the error class the query
 * paths already raise, so existing error handling applies unchanged) with the
 * original ZodError preserved as `cause` and the record id in the message.
 */
function assertReadableProject(project: NovelProject, context: string): void {
  const result = NovelProjectSchema.safeParse(project);
  if (!result.success) {
    const id = String((project as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}

/** Validates a project, translating a Zod failure into a diagnostics-preserving error. */
function validateProject(project: NovelProject): NovelProject {
  const result = NovelProjectSchema.safeParse(project);
  if (!result.success) {
    throw new ProjectValidationError(
      `Project "${String(project?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  // Return the parsed copy, never the caller's object, and do not mutate it.
  return result.data;
}

/** Detects Dexie/IndexedDB primary-key collisions across implementations. */
function isConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: unknown }).name === 'ConstraintError'
  );
}
