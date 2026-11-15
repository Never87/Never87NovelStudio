/**
 * Book Assembly Service (P9 Batch A — read-only).
 *
 * Builds a deterministic, project-scoped `BookAssemblyModel` from existing data,
 * for the publishing pipeline. This is the ONLY place that retrieves publishing
 * data; writers and the formatting pipeline never touch the database.
 *
 * Retrieval goes through the EXISTING services so ordering and ownership rules
 * are identical to the rest of the app:
 *   - Volumes: `OutlineService.getOutline` order (canonical project order).
 *   - Chapters: each volume's chapters in `order` ascending (canonical order).
 *   - Chapter prose: `ManuscriptService.getDraft('chapter', chapterId)` — the
 *     AUTHORITATIVE source. Scene prose is NEVER concatenated into chapter prose
 *     (SceneService is only used, optionally, for a scene COUNT — never content).
 *
 * Read-only contract: this service never saves, snapshots, versions or mutates
 * any record. Missing chapter drafts are represented as an explicit `empty`
 * source with empty content — a chapter is never silently dropped.
 *
 * Scope: whole-book assembly and single-chapter assembly. Both share the same
 * retrieval helpers so there is one code path, not two.
 */

import { OutlineService } from './outline-service';
import { ManuscriptService } from './manuscript-service';
import { SceneService } from './scene-service';
import { ProjectService } from './project-service';
import { computeTextStats } from '@/utils/manuscript-text';
import type { NovelProject } from '@/types';
import type {
  AssemblyChapter,
  AssemblyProjectMetadata,
  AssemblyVolume,
  BookAssemblyModel,
} from '@/modules/publishing/types';

/** Raised when the requested project (or chapter) cannot be assembled. */
export class BookAssemblyError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'BookAssemblyError';
    this.cause = cause;
  }
}

/** Options for `assembleBook` / `assembleChapter`. */
export interface AssembleOptions {
  /**
   * When `true`, each chapter's `sceneCount` is filled from `SceneService`.
   * Defaults to `true`; set to `false` to avoid the extra query. Scene PROSE is
   * never included regardless of this flag.
   */
  includeSceneCounts?: boolean;
}

/** Dependencies are injectable (defaults = the shared app services). */
export interface BookAssemblyDeps {
  outlineService?: OutlineService;
  manuscriptService?: ManuscriptService;
  sceneService?: SceneService;
  projectService?: ProjectService;
}

/**
 * Read-only assembly of a project's book structure + chapter prose.
 */
export class BookAssemblyService {
  private readonly outlineService: OutlineService;
  private readonly manuscriptService: ManuscriptService;
  private readonly sceneService: SceneService;
  private readonly projectService: ProjectService;

  constructor(deps: BookAssemblyDeps = {}) {
    this.outlineService = deps.outlineService ?? new OutlineService();
    this.manuscriptService = deps.manuscriptService ?? new ManuscriptService();
    this.sceneService = deps.sceneService ?? new SceneService();
    this.projectService = deps.projectService ?? new ProjectService();
  }

  /**
   * Assembles the whole book for `projectId`.
   *
   * @throws {BookAssemblyError} when the project does not exist.
   */
  async assembleBook(projectId: string, options: AssembleOptions = {}): Promise<BookAssemblyModel> {
    const includeSceneCounts = options.includeSceneCounts ?? true;

    const project = await this.loadProject(projectId);
    const outline = await this.loadOutline(projectId);
    const sceneCounts = includeSceneCounts
      ? await this.loadSceneCounts(projectId)
      : null;

    const volumes: AssemblyVolume[] = [];
    let totalChapters = 0;
    let totalWords = 0;

    for (const { volume, chapters } of outline) {
      const assemblyChapters: AssemblyChapter[] = [];
      for (const chapter of chapters) {
        const assembled = await this.assembleOneChapter(
          projectId,
          chapter.id,
          chapter.title,
          chapter.order,
          chapter.volumeId,
          chapter.status,
          sceneCounts ? sceneCounts[chapter.id] ?? 0 : 0,
        );
        assemblyChapters.push(assembled);
        totalChapters += 1;
        totalWords += assembled.stats.wordCount;
      }
      volumes.push({
        id: volume.id,
        title: volume.title,
        summary: volume.summary,
        chapters: assemblyChapters,
      });
    }

    return {
      project: toProjectMetadata(project),
      volumes,
      totalChapters,
      totalWords,
    };
  }

  /**
   * Assembles a single chapter as a one-volume, one-chapter book.
   *
   * Reuses `assembleOneChapter` so prose resolution and empty-state handling are
   * identical to whole-book assembly — no duplicated retrieval logic.
   *
   * @throws {BookAssemblyError} when the project or the chapter is missing, or
   *   when the chapter does not belong to the project.
   */
  async assembleChapter(
    projectId: string,
    chapterId: string,
    options: AssembleOptions = {},
  ): Promise<BookAssemblyModel> {
    const includeSceneCounts = options.includeSceneCounts ?? true;

    const project = await this.loadProject(projectId);

    let chapter;
    try {
      chapter = await this.outlineService.getChapter(chapterId);
    } catch (error) {
      throw new BookAssemblyError(
        `Failed to load chapter "${chapterId}" of project "${projectId}".`,
        error,
      );
    }
    if (!chapter) {
      throw new BookAssemblyError(
        `Chapter "${chapterId}" was not found in project "${projectId}".`,
      );
    }
    if (chapter.projectId !== projectId) {
      throw new BookAssemblyError(
        `Chapter "${chapterId}" does not belong to project "${projectId}".`,
      );
    }

    let sceneCount = 0;
    if (includeSceneCounts) {
      const sceneCounts = await this.loadSceneCounts(projectId);
      sceneCount = sceneCounts[chapterId] ?? 0;
    }

    const assembled = await this.assembleOneChapter(
      projectId,
      chapter.id,
      chapter.title,
      chapter.order,
      chapter.volumeId,
      chapter.status,
      sceneCount,
    );

    return {
      project: toProjectMetadata(project),
      volumes: [
        {
          id: chapter.volumeId,
          // A single-chapter assembly has no meaningful volume title in scope;
          // use an empty title so a preset's volume heading is unobtrusive.
          title: '',
          summary: '',
          chapters: [assembled],
        },
      ],
      totalChapters: 1,
      totalWords: assembled.stats.wordCount,
    };
  }

  /* ------------------------------- helpers ------------------------------- */

  /**
   * Resolves one chapter's prose from its `ChapterDraft`.
   *
   * A missing draft yields `source: 'empty'` with empty content — the chapter is
   * still represented, never dropped. Stats are recomputed from the Markdown so
   * they reflect exactly the exported prose (independent of a stale cache).
   */
  private async assembleOneChapter(
    projectId: string,
    chapterId: string,
    title: string,
    order: number,
    volumeId: string,
    status: string,
    sceneCount: number,
  ): Promise<AssemblyChapter> {
    let draft;
    try {
      draft = await this.manuscriptService.getDraft('chapter', chapterId);
    } catch (error) {
      throw new BookAssemblyError(
        `Failed to load the manuscript of chapter "${chapterId}" in project "${projectId}".`,
        error,
      );
    }

    const content = draft?.content ?? '';
    const stats = computeTextStats(content);

    return {
      id: chapterId,
      volumeId,
      title,
      order,
      status,
      source: draft ? 'draft' : 'empty',
      content,
      stats: { wordCount: stats.wordCount, characterCount: stats.characterCount },
      sceneCount,
    };
  }

  private async loadProject(projectId: string): Promise<NovelProject> {
    let project: NovelProject | null;
    try {
      project = await this.projectService.getProject(projectId);
    } catch (error) {
      throw new BookAssemblyError(`Failed to load project "${projectId}".`, error);
    }
    if (!project) {
      throw new BookAssemblyError(`Project "${projectId}" was not found.`);
    }
    return project;
  }

  private async loadOutline(projectId: string) {
    try {
      return await this.outlineService.getOutline(projectId);
    } catch (error) {
      throw new BookAssemblyError(`Failed to load the outline of project "${projectId}".`, error);
    }
  }

  /** Per-chapter scene COUNTS (never scene prose). */
  private async loadSceneCounts(projectId: string): Promise<Record<string, number>> {
    try {
      return await this.sceneService.countByProject(projectId);
    } catch (error) {
      throw new BookAssemblyError(`Failed to count scenes of project "${projectId}".`, error);
    }
  }
}

/** Projects the safe, publishing-relevant subset of a project. */
function toProjectMetadata(project: NovelProject): AssemblyProjectMetadata {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    author: project.settings.author ?? '',
    language: project.settings.language ?? '',
    genre: project.genre,
    tags: project.tags,
  };
}
