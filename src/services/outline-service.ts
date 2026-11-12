import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createChapterId, createVolumeId } from '@/utils/id';
import type { Chapter, ChapterStatus, Volume } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { NarrativeRepository } from '@/repositories/narrative-repository';
import { SceneRepository } from '@/repositories/scene-repository';
import { ManuscriptService } from './manuscript-service';
import { ProjectServiceError } from './project-service';

/** Raised when a volume/chapter id does not exist. */
export class OutlineNotFoundError extends ProjectRepositoryError {
  readonly entityId: string;

  constructor(message: string, entityId: string) {
    super(message);
    this.name = 'OutlineNotFoundError';
    this.entityId = entityId;
  }
}

/** A volume with its ordered chapters — the shape the outline UI renders. */
export interface VolumeWithChapters {
  volume: Volume;
  chapters: Chapter[];
}

export interface CreateVolumeInput {
  title: string;
  summary?: string;
}

export interface UpdateVolumeInput {
  title?: string;
  summary?: string;
}

export interface CreateChapterInput {
  title: string;
  summary?: string;
  goal?: string;
  keyEvents?: string;
  endingHook?: string;
  status?: ChapterStatus;
  /** Optional PlotBeat link. Must exist in the project's narrative plan. */
  plotBeatId?: string | null;
  characterIds?: string[];
  tags?: string[];
  /** Insert position inside the volume. Defaults to the end. */
  order?: number;
}

export interface UpdateChapterInput {
  title?: string;
  summary?: string;
  goal?: string;
  keyEvents?: string;
  endingHook?: string;
  status?: ChapterStatus;
  /** `null` clears the beat link; `undefined` leaves it unchanged. */
  plotBeatId?: string | null;
  characterIds?: string[];
  tags?: string[];
  /** Moves the chapter inside its volume. */
  order?: number;
}

/**
 * Business layer for the outline (volumes + chapters).
 *
 * Owns ids, timestamps, ordering and referential integrity:
 *   - `plotBeatId`, when supplied, MUST exist in the project's narrative plan,
 *     so a chapter can never point at a beat that does not exist.
 *   - Deleting a volume cascades to its chapters and their scenes.
 *   - Chapter order is compacted (0..n-1) after inserts, moves and deletes.
 */
export class OutlineService {
  private readonly repository: OutlineRepository;
  private readonly narrativeRepository: NarrativeRepository;
  private readonly sceneRepository: SceneRepository;
  private readonly manuscriptService: ManuscriptService;

  constructor(
    repository: OutlineRepository = new OutlineRepository(),
    narrativeRepository: NarrativeRepository = new NarrativeRepository(),
    sceneRepository: SceneRepository = new SceneRepository(),
    manuscriptService: ManuscriptService = new ManuscriptService(),
  ) {
    this.repository = repository;
    this.narrativeRepository = narrativeRepository;
    this.sceneRepository = sceneRepository;
    this.manuscriptService = manuscriptService;
  }

  /* ------------------------------- Volumes ------------------------------- */

  /** All volumes of a project with their chapters, ready for the tree UI. */
  async getOutline(projectId: string): Promise<VolumeWithChapters[]> {
    try {
      const [volumes, chapters] = await Promise.all([
        this.repository.listVolumes(projectId),
        this.repository.listChaptersByProject(projectId),
      ]);
      const byVolume = new Map<string, Chapter[]>();
      for (const chapter of chapters) {
        const list = byVolume.get(chapter.volumeId);
        if (list) list.push(chapter);
        else byVolume.set(chapter.volumeId, [chapter]);
      }
      return volumes.map((volume) => ({
        volume,
        chapters: (byVolume.get(volume.id) ?? []).sort((a, b) => a.order - b.order),
      }));
    } catch (error) {
      throw this.wrap(error, `Failed to load the outline of project "${projectId}"`);
    }
  }

  async createVolume(projectId: string, input: CreateVolumeInput): Promise<Volume> {
    const timestamp = now();
    const volume: Volume = {
      id: createVolumeId(),
      projectId,
      title: input.title,
      summary: input.summary ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      return await this.repository.createVolume(volume);
    } catch (error) {
      throw this.wrap(error, `Failed to create a volume in project "${projectId}"`);
    }
  }

  async updateVolume(volumeId: string, input: UpdateVolumeInput): Promise<Volume> {
    const existing = await this.repository.getVolume(volumeId);
    if (!existing) throw new OutlineNotFoundError(`Volume "${volumeId}" was not found`, volumeId);

    const merged: Volume = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      updatedAt: now(),
      // `id`, `projectId`, `createdAt` are never taken from input.
    };
    try {
      return await this.repository.updateVolume(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update volume "${volumeId}"`);
    }
  }

  /** Deletes a volume, its chapters and their scenes. Idempotent. */
  async deleteVolume(volumeId: string): Promise<void> {
    try {
      const chapters = await this.repository.listChaptersByVolume(volumeId);
      const scenes = await Promise.all(
        chapters.map((chapter) => this.sceneRepository.listByChapter(chapter.id)),
      );
      const flatScenes = scenes.flat();
      // Manuscripts (with their version history) go first: they are the leaf
      // rows of chapters/scenes.
      await this.manuscriptService.deleteSceneManuscripts(flatScenes.map((s) => s.id));
      await this.manuscriptService.deleteChapterManuscripts(chapters.map((c) => c.id));
      await this.sceneRepository.deleteByChapters(chapters.map((c) => c.id));
      await this.repository.deleteChaptersByVolume(volumeId);
      await this.repository.deleteVolume(volumeId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete volume "${volumeId}"`);
    }
  }

  /** Reorders volumes to match `orderedIds` (ids not listed keep their place after). */
  async reorderVolumes(projectId: string, orderedIds: string[]): Promise<Volume[]> {
    try {
      const volumes = await this.repository.listVolumes(projectId);
      const byId = new Map(volumes.map((v) => [v.id, v]));
      const ordered: Volume[] = [];
      const seen = new Set<string>();
      for (const id of orderedIds) {
        const volume = byId.get(id);
        if (volume && !seen.has(id)) {
          ordered.push(volume);
          seen.add(id);
        }
      }
      for (const volume of volumes) if (!seen.has(volume.id)) ordered.push(volume);

      // Volume ordering is presentation-only: stamp updatedAt so it persists
      // deterministically via creation-time-independent sorting.
      const timestamp = now();
      const stamped = ordered.map((volume, index) => ({
        ...volume,
        updatedAt: timestamp + index,
        createdAt: timestamp + index,
      }));
      await this.repository.putVolumes(stamped);
      return stamped;
    } catch (error) {
      throw this.wrap(error, `Failed to reorder volumes of project "${projectId}"`);
    }
  }

  /* ------------------------------ Chapters ------------------------------- */

  async createChapter(
    projectId: string,
    volumeId: string,
    input: CreateChapterInput,
  ): Promise<Chapter> {
    const volume = await this.repository.getVolume(volumeId);
    if (!volume) throw new OutlineNotFoundError(`Volume "${volumeId}" was not found`, volumeId);
    if (volume.projectId !== projectId) {
      throw new OutlineNotFoundError(
        `Volume "${volumeId}" does not belong to project "${projectId}"`,
        volumeId,
      );
    }
    await this.assertBeatBelongsToProject(projectId, input.plotBeatId);

    const siblings = await this.repository.listChaptersByVolume(volumeId);
    const timestamp = now();
    const chapter: Chapter = {
      id: createChapterId(),
      volumeId,
      projectId,
      title: input.title,
      order: clampOrder(input.order, siblings.length),
      summary: input.summary ?? '',
      goal: input.goal ?? '',
      keyEvents: input.keyEvents ?? '',
      endingHook: input.endingHook ?? '',
      status: input.status ?? 'planned',
      characterIds: dedupe(input.characterIds ?? []),
      tags: input.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.plotBeatId ? { plotBeatId: input.plotBeatId } : {}),
    };

    try {
      const created = await this.repository.createChapter(chapter);
      await this.compactOrder(volumeId);
      return created;
    } catch (error) {
      throw this.wrap(error, `Failed to create a chapter in volume "${volumeId}"`);
    }
  }

  async updateChapter(chapterId: string, input: UpdateChapterInput): Promise<Chapter> {
    const existing = await this.repository.getChapter(chapterId);
    if (!existing) {
      throw new OutlineNotFoundError(`Chapter "${chapterId}" was not found`, chapterId);
    }
    await this.assertBeatBelongsToProject(existing.projectId, input.plotBeatId);

    const merged: Chapter = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.keyEvents !== undefined ? { keyEvents: input.keyEvents } : {}),
      ...(input.endingHook !== undefined ? { endingHook: input.endingHook } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.characterIds !== undefined ? { characterIds: dedupe(input.characterIds) } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.order !== undefined ? { order: clampOrder(input.order, undefined) } : {}),
      updatedAt: now(),
    };

    // `null` clears the beat link; `undefined` keeps it.
    if (input.plotBeatId !== undefined) {
      if (input.plotBeatId === null || input.plotBeatId === '') delete merged.plotBeatId;
      else merged.plotBeatId = input.plotBeatId;
    }

    try {
      await this.repository.updateChapter(merged);
      if (input.order !== undefined) {
        // An explicit `order` means "insert at this position": the other
        // chapters shift down, so setting order 0 always moves the chapter to
        // the top instead of tying with the current first chapter.
        const siblings = (await this.repository.listChaptersByVolume(existing.volumeId)).filter(
          (chapter) => chapter.id !== chapterId,
        );
        const position = Math.min(Math.max(0, merged.order), siblings.length);
        siblings.splice(position, 0, merged);
        const stamped = this.stampOrder(siblings);
        await this.repository.putChapters(stamped);
        return stamped.find((chapter) => chapter.id === chapterId) ?? merged;
      }
      return merged;
    } catch (error) {
      throw this.wrap(error, `Failed to update chapter "${chapterId}"`);
    }
  }

  /** Moves a chapter up/down among its siblings. */
  async moveChapter(chapterId: string, direction: -1 | 1): Promise<Chapter[]> {
    const existing = await this.repository.getChapter(chapterId);
    if (!existing) {
      throw new OutlineNotFoundError(`Chapter "${chapterId}" was not found`, chapterId);
    }
    try {
      const siblings = await this.repository.listChaptersByVolume(existing.volumeId);
      const index = siblings.findIndex((c) => c.id === chapterId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= siblings.length) return siblings;

      const reordered = [...siblings];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      const stamped = this.stampOrder(reordered);
      await this.repository.putChapters(stamped);
      return stamped;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw this.wrap(error, `Failed to move chapter "${chapterId}"`);
    }
  }

  /** Deletes a chapter and its scenes. Idempotent. */
  async deleteChapter(chapterId: string): Promise<void> {
    const existing = await this.repository.getChapter(chapterId);
    try {
      // Manuscripts are the leaf rows: scene prose, then chapter prose, then
      // the design records they belong to.
      const scenes = await this.sceneRepository.listByChapter(chapterId);
      await this.manuscriptService.deleteSceneManuscripts(scenes.map((s) => s.id));
      await this.manuscriptService.deleteChapterManuscripts([chapterId]);
      await this.sceneRepository.deleteByChapter(chapterId);
      await this.repository.deleteChapter(chapterId);
      if (existing) await this.compactOrder(existing.volumeId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete chapter "${chapterId}"`);
    }
  }

  /** Chapters of a volume, ordered. */
  async listChapters(volumeId: string): Promise<Chapter[]> {
    try {
      return await this.repository.listChaptersByVolume(volumeId);
    } catch (error) {
      throw this.wrap(error, `Failed to list chapters of volume "${volumeId}"`);
    }
  }

  /** One chapter, or `null`. */
  async getChapter(chapterId: string): Promise<Chapter | null> {
    try {
      return await this.repository.getChapter(chapterId);
    } catch (error) {
      throw this.wrap(error, `Failed to load chapter "${chapterId}"`);
    }
  }

  /** Every chapter of a project (ordered by volume, then order). */
  async listProjectChapters(projectId: string): Promise<Chapter[]> {
    try {
      return await this.repository.listChaptersByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list chapters of project "${projectId}"`);
    }
  }

  /** Removes every volume & chapter of a project (used by project cascade). */
  async deleteOutlineByProject(projectId: string): Promise<void> {
    try {
      await this.repository.deleteChaptersByProjectId(projectId);
      await this.repository.deleteVolumesByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete the outline of project "${projectId}"`);
    }
  }

  /* ------------------------------- helpers ------------------------------- */

  /**
   * Verifies an optional beat link against the project's narrative plan.
   *
   * A `null`/`undefined` link is always valid (chapter is simply not linked).
   * A non-empty id must exist in THIS project's plan, so a chapter can never
   * reference another project's beat.
   */
  private async assertBeatBelongsToProject(
    projectId: string,
    plotBeatId: string | null | undefined,
  ): Promise<void> {
    if (!plotBeatId) return;
    let plan = null;
    try {
      plan = await this.narrativeRepository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to verify the plot beat for project "${projectId}"`);
    }
    const found = plan?.beats.some((beat) => beat.id === plotBeatId) ?? false;
    if (!found) {
      throw new OutlineNotFoundError(
        `Plot beat "${plotBeatId}" was not found in the narrative plan of project "${projectId}"`,
        plotBeatId,
      );
    }
  }

  /** Rewrites `order` to 0..n-1 for a volume's chapters. */
  private async compactOrder(volumeId: string): Promise<void> {
    const chapters = await this.repository.listChaptersByVolume(volumeId);
    const needsFix = chapters.some((chapter, index) => chapter.order !== index);
    if (!needsFix) return;
    await this.repository.putChapters(this.stampOrder(chapters));
  }

  /** Returns copies of `chapters` with dense 0..n-1 order values. */
  private stampOrder(chapters: Chapter[]): Chapter[] {
    return chapters.map((chapter, index) =>
      chapter.order === index ? chapter : { ...chapter, order: index, updatedAt: now() },
    );
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

/** Clamps a requested insert position into `0..max`. */
function clampOrder(order: number | undefined, max: number | undefined): number {
  if (order === undefined || !Number.isFinite(order)) return max ?? 0;
  const limit = max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(0, Math.round(order)), limit);
}

/** Removes duplicate ids while preserving order. */
export function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
