import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createSceneId } from '@/utils/id';
import type { Scene, ScenePurpose, SceneStatus } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { SceneRepository } from '@/repositories/scene-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { ManuscriptService } from './manuscript-service';
import { ProjectServiceError } from './project-service';
import { OutlineNotFoundError } from './outline-service';

export interface CreateSceneInput {
  title: string;
  summary?: string;
  location?: string;
  timeOfDay?: string;
  povCharacterId?: string | null;
  characterIds?: string[];
  goal?: string;
  conflict?: string;
  turningPoint?: string;
  outcome?: string;
  purpose?: ScenePurpose;
  status?: SceneStatus;
  targetWords?: number | null;
  tags?: string[];
  /** Insert position inside the chapter. Defaults to the end. */
  order?: number;
}

export interface UpdateSceneInput {
  title?: string;
  summary?: string;
  location?: string;
  timeOfDay?: string;
  /** `null` clears the POV; `undefined` leaves it unchanged. */
  povCharacterId?: string | null;
  characterIds?: string[];
  goal?: string;
  conflict?: string;
  turningPoint?: string;
  outcome?: string;
  purpose?: ScenePurpose;
  status?: SceneStatus;
  /** `null` clears the target; `undefined` leaves it unchanged. */
  targetWords?: number | null;
  tags?: string[];
  order?: number;
}

/**
 * Business layer for scene design.
 *
 * Owns ids, timestamps, ordering within a chapter, and chapter→project
 * consistency: a scene can only be created in a chapter of the SAME project,
 * and it inherits that chapter's `projectId` (never trusting the caller).
 */
export class SceneService {
  private readonly repository: SceneRepository;
  private readonly outlineRepository: OutlineRepository;
  private readonly manuscriptService: ManuscriptService;

  constructor(
    repository: SceneRepository = new SceneRepository(),
    outlineRepository: OutlineRepository = new OutlineRepository(),
    manuscriptService: ManuscriptService = new ManuscriptService(),
  ) {
    this.repository = repository;
    this.outlineRepository = outlineRepository;
    this.manuscriptService = manuscriptService;
  }

  /** Scenes of a chapter, ordered. */
  async listScenes(chapterId: string): Promise<Scene[]> {
    try {
      return await this.repository.listByChapter(chapterId);
    } catch (error) {
      throw this.wrap(error, `Failed to list scenes of chapter "${chapterId}"`);
    }
  }

  /** Scene counts keyed by chapter id for one project (outline badges). */
  async countByProject(projectId: string): Promise<Record<string, number>> {
    try {
      const scenes = await this.repository.listByProject(projectId);
      const counts: Record<string, number> = {};
      for (const scene of scenes) {
        counts[scene.chapterId] = (counts[scene.chapterId] ?? 0) + 1;
      }
      return counts;
    } catch (error) {
      throw this.wrap(error, `Failed to count scenes of project "${projectId}"`);
    }
  }

  async getScene(sceneId: string): Promise<Scene | null> {
    try {
      return await this.repository.getById(sceneId);
    } catch (error) {
      throw this.wrap(error, `Failed to load scene "${sceneId}"`);
    }
  }

  /** Creates a scene inside `chapterId`. The chapter's projectId is enforced. */
  async createScene(
    projectId: string,
    chapterId: string,
    input: CreateSceneInput,
  ): Promise<Scene> {
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

    const siblings = await this.repository.listByChapter(chapterId);
    const timestamp = now();
    const scene: Scene = {
      id: createSceneId(),
      chapterId,
      projectId,
      title: input.title,
      order: clampOrder(input.order, siblings.length),
      summary: input.summary ?? '',
      location: input.location ?? '',
      timeOfDay: input.timeOfDay ?? '',
      characterIds: dedupe(input.characterIds ?? []),
      goal: input.goal ?? '',
      conflict: input.conflict ?? '',
      turningPoint: input.turningPoint ?? '',
      outcome: input.outcome ?? '',
      purpose: input.purpose ?? 'setup',
      status: input.status ?? 'planned',
      tags: input.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.povCharacterId ? { povCharacterId: input.povCharacterId } : {}),
      ...(typeof input.targetWords === 'number' ? { targetWords: input.targetWords } : {}),
    };

    try {
      const created = await this.repository.create(scene);
      await this.compactOrder(chapterId);
      return created;
    } catch (error) {
      throw this.wrap(error, `Failed to create a scene in chapter "${chapterId}"`);
    }
  }

  async updateScene(sceneId: string, input: UpdateSceneInput): Promise<Scene> {
    const existing = await this.repository.getById(sceneId);
    if (!existing) {
      throw new OutlineNotFoundError(`Scene "${sceneId}" was not found`, sceneId);
    }

    const merged: Scene = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.timeOfDay !== undefined ? { timeOfDay: input.timeOfDay } : {}),
      ...(input.characterIds !== undefined ? { characterIds: dedupe(input.characterIds) } : {}),
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.conflict !== undefined ? { conflict: input.conflict } : {}),
      ...(input.turningPoint !== undefined ? { turningPoint: input.turningPoint } : {}),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.order !== undefined ? { order: clampOrder(input.order, undefined) } : {}),
      updatedAt: now(),
    };

    // Optional fields support explicit clearing via `null`.
    if (input.povCharacterId !== undefined) {
      if (input.povCharacterId === null || input.povCharacterId === '') delete merged.povCharacterId;
      else merged.povCharacterId = input.povCharacterId;
    }
    if (input.targetWords !== undefined) {
      if (input.targetWords === null) delete merged.targetWords;
      else merged.targetWords = input.targetWords;
    }

    try {
      await this.repository.update(merged);
      if (input.order !== undefined) {
        // Explicit `order` = insert at this position; siblings shift down.
        const siblings = (await this.repository.listByChapter(existing.chapterId)).filter(
          (scene) => scene.id !== sceneId,
        );
        const position = Math.min(Math.max(0, merged.order), siblings.length);
        siblings.splice(position, 0, merged);
        const stamped = this.stampOrder(siblings);
        await this.repository.putMany(stamped);
        return stamped.find((scene) => scene.id === sceneId) ?? merged;
      }
      return merged;
    } catch (error) {
      throw this.wrap(error, `Failed to update scene "${sceneId}"`);
    }
  }

  /** Moves a scene up/down among its siblings. */
  async moveScene(sceneId: string, direction: -1 | 1): Promise<Scene[]> {
    const existing = await this.repository.getById(sceneId);
    if (!existing) {
      throw new OutlineNotFoundError(`Scene "${sceneId}" was not found`, sceneId);
    }
    try {
      const siblings = await this.repository.listByChapter(existing.chapterId);
      const index = siblings.findIndex((s) => s.id === sceneId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= siblings.length) return siblings;

      const reordered = [...siblings];
      const [moved] = reordered.splice(index, 1);
      reordered.splice(target, 0, moved);
      const stamped = this.stampOrder(reordered);
      await this.repository.putMany(stamped);
      return stamped;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw this.wrap(error, `Failed to move scene "${sceneId}"`);
    }
  }

  async deleteScene(sceneId: string): Promise<void> {
    const existing = await this.repository.getById(sceneId);
    try {
      // Manuscript (and its versions) first: it is the leaf row owned by this scene.
      await this.manuscriptService.deleteSceneManuscripts([sceneId]);
      await this.repository.delete(sceneId);
      if (existing) await this.compactOrder(existing.chapterId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete scene "${sceneId}"`);
    }
  }

  /** Removes every scene of a project (used by project cascade). */
  async deleteScenesByProject(projectId: string): Promise<void> {
    try {
      // Project-level cascade goes through ManuscriptService so draft versions
      // are removed together with their drafts.
      await this.manuscriptService.deleteByProject(projectId);
      await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete scenes of project "${projectId}"`);
    }
  }

  private async compactOrder(chapterId: string): Promise<void> {
    const scenes = await this.repository.listByChapter(chapterId);
    const needsFix = scenes.some((scene, index) => scene.order !== index);
    if (!needsFix) return;
    await this.repository.putMany(this.stampOrder(scenes));
  }

  private stampOrder(scenes: Scene[]): Scene[] {
    return scenes.map((scene, index) =>
      scene.order === index ? scene : { ...scene, order: index, updatedAt: now() },
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

function clampOrder(order: number | undefined, max: number | undefined): number {
  if (order === undefined || !Number.isFinite(order)) return max ?? 0;
  const limit = max ?? Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(0, Math.round(order)), limit);
}

function dedupe(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
