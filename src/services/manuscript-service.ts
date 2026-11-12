import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createChapterDraftId, createDraftVersionId, createSceneDraftId } from '@/utils/id';
import { computeTextStats } from '@/utils/manuscript-text';
import { MAX_VERSIONS_PER_DRAFT } from '@/types';
import type {
  ChapterDraft,
  Draft,
  DraftKind,
  DraftVersion,
  DraftVersionReason,
  SceneDraft,
} from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ManuscriptRepository } from '@/repositories/manuscript-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { SceneRepository } from '@/repositories/scene-repository';
import { OutlineNotFoundError } from './outline-service';
import { ProjectServiceError } from './project-service';

/**
 * Raised when a draft write loses an optimistic-concurrency race.
 *
 * `current` is the freshest stored revision, so the caller (autosave) can
 * reconcile instead of blindly overwriting newer text.
 */
export class DraftConflictError extends ProjectRepositoryError {
  readonly draftId: string;
  readonly expectedRevision: number;
  readonly currentRevision: number;

  constructor(draftId: string, expectedRevision: number, currentRevision: number) {
    super(
      `Draft "${draftId}" was modified concurrently ` +
        `(expected revision ${expectedRevision}, current ${currentRevision}).`,
    );
    this.name = 'DraftConflictError';
    this.draftId = draftId;
    this.expectedRevision = expectedRevision;
    this.currentRevision = currentRevision;
  }
}

/** Raised when a write targets a locked chapter. */
export class ChapterLockedError extends ProjectRepositoryError {
  readonly ownerId: string;

  constructor(ownerId: string) {
    super(`Chapter "${ownerId}" is locked and cannot be written to.`);
    this.name = 'ChapterLockedError';
    this.ownerId = ownerId;
  }
}

/** What the editor opens: the manuscript plus the chapter it belongs to. */
export interface ChapterEditorDocument {
  draft: ChapterDraft;
  /** True when the draft was created on the fly (no prose existed yet). */
  created: boolean;
  /** Chapters already holding prose, in outline order (prev/next navigation). */
  siblings: Array<{ id: string; title: string; hasContent: boolean; wordCount: number }>;
  /** The full project manuscript, used for whole-book word progress. */
  projectWordCount: number;
  /** Title of the chapter, mirrored here so the editor needs no second call. */
  title: string;
  chapterOrder: number;
  /** Whether the chapter is locked (set by the user through the outline). */
  locked: boolean;
}

export interface SaveDraftInput {
  content: string;
  /**
   * Revision the client believes is current. When provided and stale, the save
   * is rejected with `DraftConflictError` so an older request can never
   * overwrite newer content. When omitted, the write is unconditional.
   */
  expectedRevision?: number;
}

export interface SaveDraftResult {
  draft: ChapterDraft | SceneDraft;
  /** True when the content differs from what was stored before this call. */
  changed: boolean;
  /** A snapshot was captured as part of this save. */
  snapshot: boolean;
}

export interface RestoreVersionResult {
  draft: ChapterDraft | SceneDraft;
  version: DraftVersion;
}

/** Options shared by every draft-producing call. */
export interface CreateDraftOptions {
  /** Capture a snapshot of the previous content on each save. Default false. */
  snapshotOnSave?: boolean;
}

/**
 * Business layer for manuscript prose (writing editor, P4).
 *
 * Responsibilities:
 *   - Enforce the chapter→project / scene→chapter ownership chain, so prose can
 *     never be written into the wrong project.
 *   - Own ids, timestamps, revision counters and derived counters (word/char).
 *   - Provide optimistic concurrency (`expectedRevision`) so concurrent autosave
 *     requests cannot clobber newer text.
 *   - Refuse writes to locked chapters.
 *   - Capture immutable version snapshots and prune them to a bounded history.
 *   - Cascade-delete all manuscript data with its chapter/scene/project.
 */
export class ManuscriptService {
  private readonly repository: ManuscriptRepository;
  private readonly outlineRepository: OutlineRepository;
  private readonly sceneRepository: SceneRepository;

  constructor(
    repository: ManuscriptRepository = new ManuscriptRepository(),
    outlineRepository: OutlineRepository = new OutlineRepository(),
    sceneRepository: SceneRepository = new SceneRepository(),
  ) {
    this.repository = repository;
    this.outlineRepository = outlineRepository;
    this.sceneRepository = sceneRepository;
  }

  /* --------------------------- Chapter drafts ---------------------------- */

  /**
   * Loads a chapter's manuscript, creating an empty one when it does not exist
   * yet. Returns the chapter's outline siblings so the editor can offer
   * previous/next navigation without a second request.
   */
  async openChapterDraft(projectId: string, chapterId: string): Promise<ChapterEditorDocument> {
    const chapter = await this.requireChapter(projectId, chapterId);

    // Atomic upsert: two concurrent opens (StrictMode double effect, double
    // click, two tabs) must not both create a draft — `chapterDrafts.ownerId`
    // is UNIQUE, so a check-then-create would fail the second writer.
    const { draft, created } = await this.repository.ensureChapterDraft(chapterId, () =>
      this.newChapterDraft(projectId, chapterId),
    );

    const outline = await this.outlineRepository.listChaptersByProject(projectId);
    const siblings = await Promise.all(
      outline.map(async (sibling) => {
        const siblingDraft = await this.repository.getChapterDraft(sibling.id);
        return {
          id: sibling.id,
          title: sibling.title,
          hasContent: (siblingDraft?.wordCount ?? 0) > 0,
          wordCount: siblingDraft?.wordCount ?? 0,
        };
      }),
    );

    const projectWordCount = siblings.reduce((sum, sibling) => sum + sibling.wordCount, 0);

    return {
      draft,
      created,
      siblings,
      projectWordCount,
      title: chapter.title,
      chapterOrder: chapter.order,
      locked: chapter.status === 'final',
    };
  }

  /** Saves chapter prose. See `SaveDraftInput.expectedRevision`. */
  async saveChapterDraft(
    projectId: string,
    chapterId: string,
    input: SaveDraftInput,
    options: CreateDraftOptions = {},
  ): Promise<SaveDraftResult> {
    const chapter = await this.requireChapter(projectId, chapterId);
    if (chapter.status === 'final') throw new ChapterLockedError(chapterId);

    const current = await this.repository.getChapterDraft(chapterId);
    this.assertRevision(current, input.expectedRevision);

    const base = current ?? this.newChapterDraft(projectId, chapterId);
    const stats = computeTextStats(input.content);
    const changed = base.content !== input.content;

    const next: ChapterDraft = {
      ...base,
      content: input.content,
      ...stats,
      revision: base.revision + (changed ? 1 : 0),
      updatedAt: changed ? now() : base.updatedAt,
    };

    let snapshot = false;
    if (changed && options.snapshotOnSave) {
      snapshot = await this.snapshot(next, 'auto');
    }

    const saved = current
      ? await this.repository.putChapterDraft(next)
      : await this.repository.createChapterDraft(next);

    return { draft: saved, changed, snapshot };
  }

  /* ---------------------------- Scene drafts ----------------------------- */

  /** Loads a scene's manuscript, creating an empty one when absent. */
  async openSceneDraft(projectId: string, sceneId: string): Promise<SceneDraft> {
    const scene = await this.sceneRepository.getById(sceneId);
    if (!scene) {
      throw new OutlineNotFoundError(`Scene "${sceneId}" was not found`, sceneId);
    }
    if (scene.projectId !== projectId) {
      throw new OutlineNotFoundError(
        `Scene "${sceneId}" does not belong to project "${projectId}"`,
        sceneId,
      );
    }
    // Same atomic-upsert contract as chapters: `sceneDrafts.ownerId` is UNIQUE.
    const { draft } = await this.repository.ensureSceneDraft(sceneId, () =>
      this.newSceneDraft(projectId, sceneId),
    );
    return draft;
  }

  /** Saves scene prose with the same concurrency contract as chapters. */
  async saveSceneDraft(
    projectId: string,
    sceneId: string,
    input: SaveDraftInput,
    options: CreateDraftOptions = {},
  ): Promise<SaveDraftResult> {
    const scene = await this.sceneRepository.getById(sceneId);
    if (!scene) throw new OutlineNotFoundError(`Scene "${sceneId}" was not found`, sceneId);
    if (scene.projectId !== projectId) {
      throw new OutlineNotFoundError(
        `Scene "${sceneId}" does not belong to project "${projectId}"`,
        sceneId,
      );
    }

    const current = await this.repository.getSceneDraft(sceneId);
    this.assertRevision(current, input.expectedRevision);

    const base = current ?? this.newSceneDraft(projectId, sceneId);
    const stats = computeTextStats(input.content);
    const changed = base.content !== input.content;

    const next: SceneDraft = {
      ...base,
      content: input.content,
      ...stats,
      revision: base.revision + (changed ? 1 : 0),
      updatedAt: changed ? now() : base.updatedAt,
    };

    let snapshot = false;
    if (changed && options.snapshotOnSave) {
      snapshot = await this.snapshot(next, 'auto');
    }

    const saved = current
      ? await this.repository.putSceneDraft(next)
      : await this.repository.createSceneDraft(next);

    return { draft: saved, changed, snapshot };
  }

  /** Reads any draft by kind without touching the database beyond one lookup. */
  async getDraft(kind: DraftKind, ownerId: string): Promise<Draft | null> {
    try {
      return kind === 'chapter'
        ? await this.repository.getChapterDraft(ownerId)
        : await this.repository.getSceneDraft(ownerId);
    } catch (error) {
      throw this.wrap(error, `Failed to load the ${kind} draft "${ownerId}"`);
    }
  }

  /**
   * Reads a draft by its OWN record id (as opposed to `getDraft`, which takes
   * the owning chapter/scene id). Version history refers to drafts by record id.
   */
  async getDraftById(kind: DraftKind, draftId: string): Promise<Draft | null> {
    try {
      if (kind === 'chapter') {
        const row = await this.repository.getChapterDraftById(draftId);
        return row;
      }
      return await this.repository.getSceneDraftById(draftId);
    } catch (error) {
      throw this.wrap(error, `Failed to load the ${kind} draft record "${draftId}"`);
    }
  }

  /* ------------------------------ Versions ------------------------------- */

  /** Snapshots of one draft, newest first. */
  async listVersions(draftId: string): Promise<DraftVersion[]> {
    try {
      return await this.repository.listVersions(draftId);
    } catch (error) {
      throw this.wrap(error, `Failed to list versions of draft "${draftId}"`);
    }
  }

  /** Captures a manual snapshot of the CURRENT stored content. */
  async createManualVersion(kind: DraftKind, ownerId: string, label = ''): Promise<DraftVersion> {
    const draft = await this.getDraft(kind, ownerId);
    if (!draft) {
      throw new OutlineNotFoundError(`Draft of ${kind} "${ownerId}" was not found`, ownerId);
    }
    return this.snapshotRecord(draft, 'manual', label);
  }

  /**
   * Restores a historical version.
   *
   * History is append-only: restoring writes the snapshot back as the NEW
   * current draft (revision + 1) and records a `restore` entry, so the version
   * that was replaced is preserved and the restore itself is auditable.
   */
  async restoreVersion(versionId: string): Promise<RestoreVersionResult> {
    const version = await this.repository.getVersion(versionId);
    if (!version) {
      throw new OutlineNotFoundError(`Version "${versionId}" was not found`, versionId);
    }

    // `version.draftId` is the DRAFT row id, not the chapter/scene id, so the
    // draft must be loaded by its own id before its owner can be resolved.
    const draft = await this.getDraftById(version.kind, version.draftId);
    if (!draft) {
      throw new OutlineNotFoundError(
        `Draft "${version.draftId}" of version "${versionId}" was not found`,
        versionId,
      );
    }
    const ownerId = draft.ownerId;
    if (version.kind === 'chapter') {
      const chapter = await this.outlineRepository.getChapter(ownerId);
      if (chapter?.status === 'final') throw new ChapterLockedError(ownerId);
    }

    const stats = computeTextStats(version.content);
    const next = {
      ...draft,
      content: version.content,
      ...stats,
      revision: draft.revision + 1,
      updatedAt: now(),
    } as Draft;

    const saved =
      next.kind === 'chapter'
        ? await this.repository.putChapterDraft(next)
        : await this.repository.putSceneDraft(next);

    await this.snapshotRecord(saved, 'restore', `Restored version r${version.revision}`);
    return { draft: saved, version };
  }

  /* ------------------------------ Cascades ------------------------------- */

  /**
   * Deletes the manuscripts of several chapters AND their version history.
   *
   * The two steps belong together: version rows are keyed by draft id, so once
   * the drafts are gone the snapshots can no longer be reached — deleting only
   * the drafts would leak orphans.
   */
  async deleteChapterManuscripts(chapterIds: string[]): Promise<void> {
    if (chapterIds.length === 0) return;
    try {
      const drafts = await this.repository.listChapterDraftsByOwnerIds(chapterIds);
      await this.repository.deleteVersionsByDraftIds(drafts.map((draft) => draft.id));
      await this.repository.deleteChapterDraftsByOwnerIds(chapterIds);
    } catch (error) {
      throw this.wrap(error, 'Failed to delete the manuscripts of several chapters');
    }
  }

  /** Same contract as `deleteChapterManuscripts`, for scenes. */
  async deleteSceneManuscripts(sceneIds: string[]): Promise<void> {
    if (sceneIds.length === 0) return;
    try {
      const drafts = await this.repository.listSceneDraftsByOwnerIds(sceneIds);
      await this.repository.deleteVersionsByDraftIds(drafts.map((draft) => draft.id));
      await this.repository.deleteSceneDraftsByOwnerIds(sceneIds);
    } catch (error) {
      throw this.wrap(error, 'Failed to delete the manuscripts of several scenes');
    }
  }

  /** Deletes one chapter's manuscript and every version of it. */
  async deleteByChapterId(chapterId: string): Promise<void> {
    await this.deleteChapterManuscripts([chapterId]);
  }

  /** Deletes one scene's manuscript and every version of it. */
  async deleteBySceneId(sceneId: string): Promise<void> {
    await this.deleteSceneManuscripts([sceneId]);
  }

  /** Deletes every manuscript row of a project (project cascade). */
  async deleteByProject(projectId: string): Promise<void> {
    try {
      await this.repository.deleteVersionsByProject(projectId);
      await this.repository.deleteChapterDraftsByProject(projectId);
      await this.repository.deleteSceneDraftsByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete the manuscripts of project "${projectId}"`);
    }
  }

  /** Total written words of a project (chapter prose + scene prose). */
  async countProjectWords(projectId: string): Promise<number> {
    try {
      const [chapterWords, sceneWords] = await Promise.all([
        this.repository.countChapterDraftWords(projectId),
        this.repository.countSceneDraftWords(projectId),
      ]);
      return chapterWords + sceneWords;
    } catch (error) {
      throw this.wrap(error, `Failed to count the words of project "${projectId}"`);
    }
  }

  /* ------------------------------- helpers ------------------------------- */

  /** Creates a zeroed chapter draft record. */
  private newChapterDraft(projectId: string, ownerId: string): ChapterDraft {
    const timestamp = now();
    return {
      id: createChapterDraftId(),
      kind: 'chapter',
      projectId,
      ownerId,
      content: '',
      plainText: '',
      wordCount: 0,
      characterCount: 0,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** Creates a zeroed scene draft record. */
  private newSceneDraft(projectId: string, ownerId: string): SceneDraft {
    const timestamp = now();
    return {
      id: createSceneDraftId(),
      kind: 'scene',
      projectId,
      ownerId,
      content: '',
      plainText: '',
      wordCount: 0,
      characterCount: 0,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  /** Resolves a chapter and verifies it belongs to the project. */
  private async requireChapter(projectId: string, chapterId: string) {
    const chapter = await this.outlineRepository.getChapter(chapterId);
    if (!chapter) {
      throw new OutlineNotFoundError(`Chapter "${chapterId}" was not found`, chapterId);
    }
    if (chapter.projectId !== projectId) {
      throw new OutlineNotFoundError(
        `Chapter "${chapterId}" does not belong to project "${projectId}"`,
        chapterId,
      );
    }
    return chapter;
  }

  /**
   * Optimistic concurrency check.
   *
   * A missing draft has revision 0, so the first save must be sent with
   * `expectedRevision: 0` (or omitted). A stale expectation throws
   * `DraftConflictError`, which the autosave layer treats as "someone else
   * wrote newer text".
   */
  private assertRevision(current: Draft | null, expected: number | undefined): void {
    if (expected === undefined) return;
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expected) {
      throw new DraftConflictError(current?.id ?? '<new>', expected, currentRevision);
    }
  }

  /** Captures a snapshot if it would meaningfully add history. */
  private async snapshot(draft: Draft, reason: DraftVersionReason): Promise<boolean> {
    const latest = await this.repository.listVersions(draft.id);
    if (latest[0]?.content === draft.content) return false;
    await this.snapshotRecord(draft, reason, '');
    return true;
  }

  private async snapshotRecord(
    draft: Draft,
    reason: DraftVersionReason,
    label: string,
  ): Promise<DraftVersion> {
    const version: DraftVersion = {
      id: createDraftVersionId(),
      draftId: draft.id,
      projectId: draft.projectId,
      kind: draft.kind,
      revision: draft.revision,
      content: draft.content,
      wordCount: draft.wordCount,
      reason,
      label,
      createdAt: now(),
    };
    const saved = await this.repository.addVersion(version);
    await this.prune(draft.id);
    return saved;
  }

  /** Keeps only the newest `MAX_VERSIONS_PER_DRAFT` snapshots. */
  private async prune(draftId: string): Promise<void> {
    const versions = await this.repository.listVersions(draftId);
    if (versions.length <= MAX_VERSIONS_PER_DRAFT) return;
    const surplus = versions.slice(MAX_VERSIONS_PER_DRAFT).map((version) => version.id);
    await this.repository.deleteVersionsByDraft(draftId, surplus);
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
