import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { SceneSchema } from '@/schemas/scene';
import type { Scene } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for scenes.
 *
 * Pure persistence only: validates every write and every read against
 * `SceneSchema`, exactly like the other repositories.
 */
export class SceneRepository {
  private readonly table: Table<Scene, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.scenes;
  }

  /** Scenes of one chapter, ordered by `order`. */
  async listByChapter(chapterId: string): Promise<Scene[]> {
    let rows: Scene[];
    try {
      rows = await this.table.where('chapterId').equals(chapterId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list scenes of chapter "${chapterId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadableScene(row, `Failed to list scenes (record at position ${index})`),
    );
    return rows.sort(compareScenes);
  }

  /** Every scene of a project (used for counts and cascade verification). */
  async listByProject(projectId: string): Promise<Scene[]> {
    let rows: Scene[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list scenes of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadableScene(row, `Failed to list scenes (record at position ${index})`),
    );
    return rows.sort(compareScenes);
  }

  async getById(id: string): Promise<Scene | null> {
    let row: Scene | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read scene "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadableScene(row, `Failed to read scene "${id}"`);
    return row;
  }

  async create(scene: Scene): Promise<Scene> {
    const validated = validateScene(scene);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create scene "${scene.id}"`, error);
    }
  }

  async update(scene: Scene): Promise<Scene> {
    const validated = validateScene(scene);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Scene "${validated.id}" was not found`);
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update scene "${scene.id}"`, error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.table.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete scene "${id}"`, error);
    }
  }

  /** Deletes every scene of a chapter. Idempotent. */
  async deleteByChapter(chapterId: string): Promise<number> {
    try {
      return await this.table.where('chapterId').equals(chapterId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete scenes of chapter "${chapterId}"`,
        error,
      );
    }
  }

  /** Deletes every scene of several chapters in one query each. */
  async deleteByChapters(chapterIds: string[]): Promise<number> {
    if (chapterIds.length === 0) return 0;
    try {
      return await this.table.where('chapterId').anyOf(chapterIds).delete();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to delete scenes of multiple chapters', error);
    }
  }

  /** Deletes every scene of a project. Idempotent. */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete scenes of project "${projectId}"`,
        error,
      );
    }
  }

  /** Writes many scenes in one transaction (used for bulk reordering). */
  async putMany(scenes: Scene[]): Promise<void> {
    if (scenes.length === 0) return;
    const validated = scenes.map(validateScene);
    try {
      await this.table.bulkPut(validated);
    } catch (error) {
      throw new ProjectRepositoryError('Failed to save scene order', error);
    }
  }
}

/** Scenes sort by `order`, then creation time. */
function compareScenes(a: Scene, b: Scene): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.createdAt - b.createdAt;
}

function validateScene(scene: Scene): Scene {
  const result = SceneSchema.safeParse(scene);
  if (!result.success) {
    throw new ProjectValidationError(
      `Scene "${String(scene?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadableScene(scene: Scene, context: string): void {
  const result = SceneSchema.safeParse(scene);
  if (!result.success) {
    const id = String((scene as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
