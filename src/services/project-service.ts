import { ZodError } from 'zod';
import { createProjectId } from '@/utils/id';
import { now } from '@/utils/date';
import type { ProjectSettings, ProjectStatus, NovelProject } from '@/types';
import {
  ProjectRepository,
  ProjectRepositoryError,
  ProjectValidationError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
} from '@/repositories/project-repository';
import { WorldRepository } from '@/repositories/world-repository';
import { CharacterRepository } from '@/repositories/character-repository';
import { NarrativeRepository } from '@/repositories/narrative-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { SceneRepository } from '@/repositories/scene-repository';
import { ManuscriptRepository } from '@/repositories/manuscript-repository';
import { PromptRepository } from '@/repositories/prompt-repository';
import { ContextRepository } from '@/repositories/context-repository';
import { KnowledgeRepository } from '@/repositories/knowledge-repository';
import { ContinuityRepository } from '@/repositories/continuity-repository';
import { AnalysisRepository } from '@/repositories/analysis-repository';
import { ImportRepository } from '@/repositories/import-repository';

/** Base error for business-rule failures raised by the Service. */
export class ProjectServiceError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProjectServiceError';
    this.cause = cause;
  }
}

/**
 * Error types surface the underlying Repository error class so a single
 * `instanceof` check in the future UI works for both layers.
 */
export { ProjectRepositoryError, ProjectValidationError, ProjectNotFoundError, ProjectAlreadyExistsError };

/** Fields a caller may set when creating a project. Id/timestamps are Service-owned. */
export interface CreateProjectInput {
  title: string;
  description?: string;
  cover?: string;
  status?: ProjectStatus;
  genre?: string[];
  tags?: string[];
  targetWordCount?: number;
  settings?: ProjectSettings;
}

/** Fields a caller may change on an existing project.
 *
 * `id` and `createdAt` are intentionally absent — they can never be changed.
 * Every field is optional so a partial update leaves untouched data intact.
 * `settings` is shallow-merged over the existing settings (see `updateProject`);
 * an explicit `undefined` value for a settings key REMOVES that key.
 */
export interface UpdateProjectInput {
  title?: string;
  description?: string;
  /** `null` explicitly clears the cover; `undefined` leaves it unchanged. */
  cover?: string | null;
  status?: ProjectStatus;
  genre?: string[];
  tags?: string[];
  /** `null` clears the target; `undefined` leaves it unchanged. */
  targetWordCount?: number | null;
  /**
   * Shallow-merged over existing settings. A key set to `undefined` (or to an
   * empty/whitespace-only string) is removed, which is how the UI clears
   * optional fields such as `author`/`language` without writing invalid data.
   */
  settings?: Partial<Record<keyof ProjectSettings, string | undefined>>;
}

/**
 * Business layer for projects.
 *
 * Owns ids, timestamps, defaults and cross-field rules, and is the only entry
 * point the (future) UI should call. It never touches Dexie tables directly —
 * all persistence goes through the injected `ProjectRepository`.
 */
export class ProjectService {
  private readonly repository: ProjectRepository;
  private readonly worldRepository: WorldRepository;
  private readonly characterRepository: CharacterRepository;
  private readonly narrativeRepository: NarrativeRepository;
  private readonly outlineRepository: OutlineRepository;
  private readonly sceneRepository: SceneRepository;
  private readonly manuscriptRepository: ManuscriptRepository;
  private readonly promptRepository: PromptRepository;
  private readonly contextRepository: ContextRepository;
  private readonly knowledgeRepository: KnowledgeRepository;
  private readonly continuityRepository: ContinuityRepository;
  private readonly analysisRepository: AnalysisRepository;
  private readonly importRepository: ImportRepository;

  constructor(
    repository: ProjectRepository = new ProjectRepository(),
    worldRepository: WorldRepository = new WorldRepository(),
    characterRepository: CharacterRepository = new CharacterRepository(),
    narrativeRepository: NarrativeRepository = new NarrativeRepository(),
    outlineRepository: OutlineRepository = new OutlineRepository(),
    sceneRepository: SceneRepository = new SceneRepository(),
    manuscriptRepository: ManuscriptRepository = new ManuscriptRepository(),
    promptRepository: PromptRepository = new PromptRepository(),
    contextRepository: ContextRepository = new ContextRepository(),
    knowledgeRepository: KnowledgeRepository = new KnowledgeRepository(),
    continuityRepository: ContinuityRepository = new ContinuityRepository(),
    analysisRepository: AnalysisRepository = new AnalysisRepository(),
    importRepository: ImportRepository = new ImportRepository(),
  ) {
    this.repository = repository;
    this.worldRepository = worldRepository;
    this.characterRepository = characterRepository;
    this.narrativeRepository = narrativeRepository;
    this.outlineRepository = outlineRepository;
    this.sceneRepository = sceneRepository;
    this.manuscriptRepository = manuscriptRepository;
    this.promptRepository = promptRepository;
    this.contextRepository = contextRepository;
    this.knowledgeRepository = knowledgeRepository;
    this.continuityRepository = continuityRepository;
    this.analysisRepository = analysisRepository;
    this.importRepository = importRepository;
  }

  /**
   * Creates a project with generated id and timestamps.
   *
   * Defaults: `description` `''`, `status` `'planning'`, empty `genre`/`tags`,
   * empty `settings`. Legitimate caller fields are preserved.
   */
  async createProject(input: CreateProjectInput): Promise<NovelProject> {
    const timestamp = now();
    const project: NovelProject = {
      id: createProjectId(),
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'planning',
      genre: input.genre ?? [],
      tags: input.tags ?? [],
      settings: input.settings ?? {},
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.cover !== undefined ? { cover: input.cover } : {}),
      ...(input.targetWordCount !== undefined ? { targetWordCount: input.targetWordCount } : {}),
    };

    // The Repository validates with NovelProjectSchema before writing.
    try {
      return await this.repository.create(project);
    } catch (error) {
      throw this.wrap(error, `Failed to create project "${input.title}"`);
    }
  }

  /** Returns the project with `id`, or `null` when it does not exist. */
  async getProject(id: string): Promise<NovelProject | null> {
    try {
      return await this.repository.getById(id);
    } catch (error) {
      throw this.wrap(error, `Failed to load project "${id}"`);
    }
  }

  /** All projects, most recently updated first. */
  async listProjects(): Promise<NovelProject[]> {
    try {
      return await this.repository.getAll();
    } catch (error) {
      throw this.wrap(error, 'Failed to list projects');
    }
  }

  /** Projects with `status`, most recently updated first. */
  async listProjectsByStatus(status: ProjectStatus): Promise<NovelProject[]> {
    try {
      return await this.repository.getByStatus(status);
    } catch (error) {
      throw this.wrap(error, `Failed to list projects with status "${status}"`);
    }
  }

  /**
   * Applies a partial update to an existing project.
   *
   * - Fails when the project does not exist (never creates it).
   * - Never allows `id` or `createdAt` to change.
   * - Leaves omitted fields untouched, so a partial patch cannot wipe data.
   * - `settings` is shallow-merged over existing settings; pass `{}` to keep
   *   them, or explicitly set a key to `undefined`-free values to change it.
   * - Refreshes `updatedAt` and re-validates the merged project.
   */
  async updateProject(id: string, input: UpdateProjectInput): Promise<NovelProject> {
    let existing: NovelProject | null;
    try {
      existing = await this.repository.getById(id);
    } catch (error) {
      throw this.wrap(error, `Failed to load project "${id}"`);
    }
    if (!existing) {
      throw new ProjectNotFoundError(id);
    }

    const merged: NovelProject = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.genre !== undefined ? { genre: input.genre } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.settings !== undefined
        ? { settings: mergeSettings(existing.settings, input.settings) }
        : {}),
      updatedAt: now(),
      // `id` and `createdAt` stay as they were — deliberately not spread from input.
    };

    // Optional fields support explicit clearing via `null`.
    if (input.cover !== undefined) {
      if (input.cover === null) delete merged.cover;
      else merged.cover = input.cover;
    }
    if (input.targetWordCount !== undefined) {
      if (input.targetWordCount === null) delete merged.targetWordCount;
      else merged.targetWordCount = input.targetWordCount;
    }

    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update project "${id}"`);
    }
  }

  /**
   * Deletes a project AND every child record that belongs to it.
   *
   * Cascade order: children first, then the project itself. Deleting children
   * first means a mid-way failure never leaves the project gone while its
   * world/characters are still orphaned and unlinked from any UI entry point.
   *
   * - Child deletion is idempotent (`deleteByProjectId` treats "nothing to
   *   delete" as success), so deleting a project with no children is fine.
   * - The project delete still fails loudly when the project itself is missing,
   *   preserving the existing P1 contract.
   * - Child rows are removed by `projectId` index, not by loading and deleting
   *   one by one, so cleanup stays O(1) queries regardless of cast size.
   */
  async deleteProject(id: string): Promise<void> {
    try {
      // 1. Cascade children (idempotent).
      //    Manuscripts (drafts + versions) go FIRST: they are the leaf rows of
      //    chapters/scenes, so deleting them before their owners keeps the
      //    delete order child-first even for prose.
      await this.manuscriptRepository.deleteVersionsByProject(id);
      await this.manuscriptRepository.deleteChapterDraftsByProject(id);
      await this.manuscriptRepository.deleteSceneDraftsByProject(id);
      await this.worldRepository.deleteByProjectId(id);
      await this.characterRepository.deleteByProjectId(id);
      await this.narrativeRepository.deleteByProjectId(id);
      // Scenes before chapters/volumes: children first, then their parents.
      await this.sceneRepository.deleteByProjectId(id);
      await this.outlineRepository.deleteChaptersByProjectId(id);
      await this.outlineRepository.deleteVolumesByProjectId(id);
      // P6: prompt templates (+ their version history) and context data are
      // project-owned and must not survive their project.
      await this.promptRepository.deleteAllByProject(id);
      await this.contextRepository.deleteAllByProject(id);
      // P7: knowledge, continuity and analysis findings are project-owned too.
      // Findings reference continuity facts/entries, so remove them first.
      await this.analysisRepository.deleteByProjectId(id);
      await this.continuityRepository.deleteByProjectId(id);
      await this.knowledgeRepository.deleteByProjectId(id);
      // P8: imported documents + their sections + extraction records. The
      // repository deletes child-first (extraction → sections → documents).
      await this.importRepository.deleteByProjectId(id);
      // 2. Then the project itself.
      await this.repository.delete(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete project "${id}"`);
    }
  }

  /** Whether a project with `id` exists. */
  async projectExists(id: string): Promise<boolean> {
    try {
      return await this.repository.exists(id);
    } catch (error) {
      throw this.wrap(error, `Failed to check project "${id}"`);
    }
  }

  /**
   * Re-throws known domain errors unchanged and wraps the rest, so the
   * original Repository/Dexie/Zod cause is always preserved.
   *
   * Domain errors (not-found, already-exists, validation) keep their concrete
   * type across the Service boundary, which lets callers distinguish "invalid
   * data" from "database failed" with a single `instanceof` check.
   */
  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    // A raw ZodError (e.g. from an injected repository) becomes a validation
    // error so callers still see "invalid data", not a generic failure.
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ProjectServiceError(message, error);
  }
}

/**
 * Shallow-merges a settings patch over existing settings.
 *
 * A key whose patch value is `undefined` or a whitespace-only string is
 * REMOVED rather than stored as `undefined`/`''`. This is what lets the UI
 * clear an optional setting (e.g. `author`) without writing a value that
 * violates the schema or leaving a `{ author: undefined }` key behind.
 * Keys absent from the patch are left untouched.
 */
function mergeSettings(
  existing: ProjectSettings,
  patch: Partial<Record<keyof ProjectSettings, string | undefined>>,
): ProjectSettings {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged as ProjectSettings;
}
