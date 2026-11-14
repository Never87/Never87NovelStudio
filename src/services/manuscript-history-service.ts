import { ZodError } from 'zod';
import type { ChapterDraft, Draft, DraftKind, DraftVersion, Scene, SceneDraft } from '@/types';
import { ManuscriptRepository } from '@/repositories/manuscript-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { SceneRepository } from '@/repositories/scene-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';

/**
 * Read-only projection of ONE draft's version history.
 *
 * The "current" fields come from the live draft row (`chapterDrafts` /
 * `sceneDrafts`); the `versions` array holds the immutable snapshots from
 * `draftVersions`. The current draft is deliberately NOT merged into
 * `versions`: it is a different kind of record (mutable, keyed by owner) and
 * conflating the two would misrepresent the model. The UI renders it as a
 * separate "Current" row so the distinction is explicit.
 */
export interface ManuscriptHistoryEntry {
  /** The DRAFT row id (`cdraft_…` / `sdraft_…`). Versions reference this. */
  draftId: string;
  kind: DraftKind;
  /** The owning chapter/scene id. */
  ownerId: string;
  /** Human label — the chapter or scene title (fallback when missing). */
  ownerTitle: string;
  /** Presentation order of the owner inside the project, when known. */
  ownerOrder: number | null;
  /** Live draft revision (`null` when the draft row is missing). */
  currentRevision: number | null;
  /** Live draft word count. */
  currentWordCount: number;
  /** Live draft Markdown (empty when the draft row is missing). */
  currentContent: string;
  /** Historical snapshots, newest revision first. */
  versions: DraftVersion[];
}

/**
 * Immutable snapshot of a project's whole manuscript history.
 *
 * One entry per draft (chapter OR scene) that currently exists in the project.
 * Used by the Version History page; the Diff Viewer narrows to a single entry.
 */
export interface ProjectHistory {
  projectId: string;
  entries: ManuscriptHistoryEntry[];
}

/**
 * Business layer for reading manuscript VERSION HISTORY (P9 B2).
 *
 * This service is deliberately READ-ONLY and purely compositional: it reuses
 * `ManuscriptRepository`, `OutlineRepository` and `SceneRepository` to join the
 * live drafts with their snapshots and with the chapter/scene titles. It does
 * NOT own a version store of its own (no new table, no migration) and it does
 * NOT perform writes — capture, restore and pruning stay in `ManuscriptService`,
 * which is the single owner of the `draftVersions` write path.
 *
 * Why a separate service rather than more methods on `ManuscriptService`?
 * History listing is a cross-cutting read that joins three repositories and is
 * only used by the two P9 B2 pages. Keeping it here leaves the editor's write
 * service focused and makes the "no new version model" boundary obvious.
 *
 * Isolation guarantees:
 *   - Every query is scoped by `projectId`, so a project can never see another
 *     project's drafts or versions.
 *   - An entry only exists when the draft row exists; versions that reference a
 *     draft row that is gone are dropped (they cannot happen through the
 *     normal cascade, but this keeps the read total and honest).
 */
export class ManuscriptHistoryService {
  private readonly manuscriptRepository: ManuscriptRepository;
  private readonly outlineRepository: OutlineRepository;
  private readonly sceneRepository: SceneRepository;

  constructor(
    manuscriptRepository: ManuscriptRepository = new ManuscriptRepository(),
    outlineRepository: OutlineRepository = new OutlineRepository(),
    sceneRepository: SceneRepository = new SceneRepository(),
  ) {
    this.manuscriptRepository = manuscriptRepository;
    this.outlineRepository = outlineRepository;
    this.sceneRepository = sceneRepository;
  }

  /**
   * Every draft with its version history, for one project.
   *
   * Ordering: chapters before scenes, each by their owner's outline order, then
   * by draft id. Within an entry, `versions` is newest-revision first (the same
   * order `ManuscriptRepository.listVersions` returns).
   */
  async listProjectHistory(projectId: string): Promise<ProjectHistory> {
    try {
      const [chapterDrafts, sceneDrafts, chapters, scenes, versions] = await Promise.all([
        this.manuscriptRepository.listChapterDraftsByProject(projectId),
        this.manuscriptRepository.listSceneDraftsByProject(projectId),
        this.outlineRepository.listChaptersByProject(projectId),
        this.sceneRepository.listByProject(projectId),
        this.manuscriptRepository.listVersionsByProject(projectId),
      ]);

      const chapterTitles = new Map(chapters.map((chapter) => [chapter.id, chapter]));
      const sceneTitles = new Map(scenes.map((scene) => [scene.id, scene]));

      // Group versions by the draft row they snapshot.
      const versionsByDraft = new Map<string, DraftVersion[]>();
      for (const version of versions) {
        const bucket = versionsByDraft.get(version.draftId);
        if (bucket) bucket.push(version);
        else versionsByDraft.set(version.draftId, [version]);
      }

      const chapterEntries = chapterDrafts.map((draft) =>
        this.toEntry(
          draft,
          versionsByDraft.get(draft.id) ?? [],
          chapterTitles.get(draft.ownerId)?.title ?? '(untitled chapter)',
          chapterTitles.get(draft.ownerId)?.order ?? null,
        ),
      );
      const sceneEntries = sceneDrafts.map((draft) =>
        this.toEntry(
          draft,
          versionsByDraft.get(draft.id) ?? [],
          sceneTitles.get(draft.ownerId)?.title ?? '(untitled scene)',
          sceneTitles.get(draft.ownerId)?.order ?? null,
        ),
      );

      const ordered = [
        ...chapterEntries.sort(compareEntries),
        ...sceneEntries.sort(compareEntries),
      ];

      return { projectId, entries: ordered };
    } catch (error) {
      throw this.wrap(error, `Failed to load the manuscript history of project "${projectId}"`);
    }
  }

  /**
   * One draft's history, by its DRAFT row id, already scoped to a project.
   *
   * Returns `null` when the draft does not exist OR belongs to another project,
   * so a caller can never cross the project boundary by guessing an id.
   */
  async getDraftHistory(
    projectId: string,
    draftId: string,
  ): Promise<ManuscriptHistoryEntry | null> {
    try {
      const draft =
        (await this.manuscriptRepository.getChapterDraftById(draftId)) ??
        (await this.manuscriptRepository.getSceneDraftById(draftId));
      if (!draft || draft.projectId !== projectId) return null;

      const [versions, ownerTitle, ownerOrder] = await Promise.all([
        this.manuscriptRepository.listVersions(draftId),
        this.resolveOwnerTitle(draft),
        this.resolveOwnerOrder(draft),
      ]);
      return this.toEntry(draft, versions, ownerTitle, ownerOrder);
    } catch (error) {
      throw this.wrap(error, `Failed to load the history of draft "${draftId}"`);
    }
  }

  /**
   * Two drafts' histories in one call, for the Diff Viewer.
   *
   * Both must belong to `projectId` and to the SAME owner (same chapter or same
   * scene) — comparison across different manuscripts is rejected here so the UI
   * cannot even build an incompatible pair. Returns `null` when either side is
   * missing or the pair is incompatible.
   */
  async getComparableDraftHistories(
    projectId: string,
    leftDraftId: string,
    rightDraftId: string,
  ): Promise<{ left: ManuscriptHistoryEntry; right: ManuscriptHistoryEntry } | null> {
    if (leftDraftId === rightDraftId) return null;
    const [left, right] = await Promise.all([
      this.getDraftHistory(projectId, leftDraftId),
      this.getDraftHistory(projectId, rightDraftId),
    ]);
    if (!left || !right) return null;
    // Compatibility: same draft kind AND same owner (the only case where the
    // two histories describe the same manuscript across time).
    if (left.kind !== right.kind || left.ownerId !== right.ownerId) return null;
    return { left, right };
  }

  private toEntry(
    draft: Draft,
    versions: DraftVersion[],
    ownerTitle: string,
    ownerOrder: number | null,
  ): ManuscriptHistoryEntry {
    // Repositories already return versions newest-revision first; sort again
    // defensively so the contract holds even if the source changes.
    const ordered = [...versions].sort(compareVersions);
    return {
      draftId: draft.id,
      kind: draft.kind,
      ownerId: draft.ownerId,
      ownerTitle,
      ownerOrder,
      currentRevision: draft.revision,
      currentWordCount: draft.wordCount,
      currentContent: draft.content,
      versions: ordered,
    };
  }

  private async resolveOwnerTitle(draft: Draft | ChapterDraft | SceneDraft): Promise<string> {
    if (draft.kind === 'chapter') {
      const chapter = await this.outlineRepository.getChapter(draft.ownerId);
      return chapter?.title ?? '(untitled chapter)';
    }
    const scene: Scene | null = await this.sceneRepository.getById(draft.ownerId);
    return scene?.title ?? '(untitled scene)';
  }

  private async resolveOwnerOrder(draft: Draft): Promise<number | null> {
    if (draft.kind === 'chapter') {
      const chapter = await this.outlineRepository.getChapter(draft.ownerId);
      return chapter?.order ?? null;
    }
    const scene = await this.sceneRepository.getById(draft.ownerId);
    return scene?.order ?? null;
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ProjectServiceError(message, error);
  }
}

/** Newest revision first; ties by creation time, then id (matches the repo). */
function compareVersions(a: DraftVersion, b: DraftVersion): number {
  if (a.revision !== b.revision) return b.revision - a.revision;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Chapters/scenes ordered by their outline order, then title, then draft id. */
function compareEntries(a: ManuscriptHistoryEntry, b: ManuscriptHistoryEntry): number {
  const ao = a.ownerOrder ?? Number.MAX_SAFE_INTEGER;
  const bo = b.ownerOrder ?? Number.MAX_SAFE_INTEGER;
  if (ao !== bo) return ao - bo;
  if (a.ownerTitle !== b.ownerTitle) return a.ownerTitle < b.ownerTitle ? -1 : 1;
  return a.draftId < b.draftId ? -1 : a.draftId > b.draftId ? 1 : 0;
}
