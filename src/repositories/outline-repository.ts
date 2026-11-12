import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ChapterSchema, VolumeSchema } from '@/schemas/outline';
import type { Chapter, Volume } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for outline volumes and chapters.
 *
 * Pure persistence only: every write is validated against its Zod schema first
 * and every read is validated back, so a malformed record can never reach the
 * Service/UI unchecked (same strategy as the other repositories).
 */
export class OutlineRepository {
  private readonly volumes: Table<Volume, string>;
  private readonly chapters: Table<Chapter, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.volumes = database.volumes;
    this.chapters = database.chapters;
  }

  /* ------------------------------- Volumes ------------------------------- */

  /** Every volume of `projectId`, ordered by creation. */
  async listVolumes(projectId: string): Promise<Volume[]> {
    let rows: Volume[];
    try {
      rows = await this.volumes.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to list volumes of project "${projectId}"`,
        error,
      );
    }
    rows.forEach((row, index) =>
      assertReadableVolume(row, `Failed to list volumes (record at position ${index})`),
    );
    // Stable presentation order: oldest first (creation order).
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getVolume(id: string): Promise<Volume | null> {
    let row: Volume | undefined;
    try {
      row = await this.volumes.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read volume "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadableVolume(row, `Failed to read volume "${id}"`);
    return row;
  }

  async createVolume(volume: Volume): Promise<Volume> {
    const validated = validateVolume(volume);
    try {
      await this.volumes.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create volume "${volume.id}"`, error);
    }
  }

  async updateVolume(volume: Volume): Promise<Volume> {
    const validated = validateVolume(volume);
    try {
      const existing = await this.volumes.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Volume "${validated.id}" was not found`);
      await this.volumes.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update volume "${volume.id}"`, error);
    }
  }

  /**
   * Deletes one volume directly (no cascade — the Service deletes its chapters
   * and their scenes first). Idempotent.
   */
  async deleteVolume(id: string): Promise<void> {
    try {
      await this.volumes.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete volume "${id}"`, error);
    }
  }

  /** Deletes all volumes of a project. Idempotent. */
  async deleteVolumesByProjectId(projectId: string): Promise<number> {
    try {
      return await this.volumes.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete volumes of project "${projectId}"`,
        error,
      );
    }
  }

  /* ------------------------------ Chapters ------------------------------- */

  /** Every chapter of `projectId`, ordered by volume then `order`. */
  async listChaptersByProject(projectId: string): Promise<Chapter[]> {
    let rows: Chapter[];
    try {
      rows = await this.chapters.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to list chapters of project "${projectId}"`,
        error,
      );
    }
    rows.forEach((row, index) =>
      assertReadableChapter(row, `Failed to list chapters (record at position ${index})`),
    );
    return rows.sort(compareChapters);
  }

  /** Chapters of one volume, ordered by `order`. */
  async listChaptersByVolume(volumeId: string): Promise<Chapter[]> {
    let rows: Chapter[];
    try {
      rows = await this.chapters.where('volumeId').equals(volumeId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list chapters of volume "${volumeId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadableChapter(row, `Failed to list chapters (record at position ${index})`),
    );
    return rows.sort(compareChapters);
  }

  async getChapter(id: string): Promise<Chapter | null> {
    let row: Chapter | undefined;
    try {
      row = await this.chapters.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read chapter "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadableChapter(row, `Failed to read chapter "${id}"`);
    return row;
  }

  async createChapter(chapter: Chapter): Promise<Chapter> {
    const validated = validateChapter(chapter);
    try {
      await this.chapters.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create chapter "${chapter.id}"`, error);
    }
  }

  async updateChapter(chapter: Chapter): Promise<Chapter> {
    const validated = validateChapter(chapter);
    try {
      const existing = await this.chapters.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Chapter "${validated.id}" was not found`);
      await this.chapters.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update chapter "${chapter.id}"`, error);
    }
  }

  async deleteChapter(id: string): Promise<void> {
    try {
      await this.chapters.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete chapter "${id}"`, error);
    }
  }

  async deleteChaptersByVolume(volumeId: string): Promise<number> {
    try {
      return await this.chapters.where('volumeId').equals(volumeId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete chapters of volume "${volumeId}"`,
        error,
      );
    }
  }

  async deleteChaptersByProjectId(projectId: string): Promise<number> {
    try {
      return await this.chapters.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete chapters of project "${projectId}"`,
        error,
      );
    }
  }

  /** Writes many chapters in one transaction (used for bulk reordering). */
  async putChapters(chapters: Chapter[]): Promise<void> {
    if (chapters.length === 0) return;
    const validated = chapters.map(validateChapter);
    try {
      await this.chapters.bulkPut(validated);
    } catch (error) {
      throw new ProjectRepositoryError('Failed to save chapter order', error);
    }
  }

  /** Writes many volumes in one transaction (used for bulk reordering). */
  async putVolumes(volumes: Volume[]): Promise<void> {
    if (volumes.length === 0) return;
    const validated = volumes.map(validateVolume);
    try {
      await this.volumes.bulkPut(validated);
    } catch (error) {
      throw new ProjectRepositoryError('Failed to save volume order', error);
    }
  }
}

/** Chapters sort by volume creation-independent `order`, then creation time. */
function compareChapters(a: Chapter, b: Chapter): number {
  if (a.order !== b.order) return a.order - b.order;
  return a.createdAt - b.createdAt;
}

function validateVolume(volume: Volume): Volume {
  const result = VolumeSchema.safeParse(volume);
  if (!result.success) {
    throw new ProjectValidationError(
      `Volume "${String(volume?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function validateChapter(chapter: Chapter): Chapter {
  const result = ChapterSchema.safeParse(chapter);
  if (!result.success) {
    throw new ProjectValidationError(
      `Chapter "${String(chapter?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadableVolume(volume: Volume, context: string): void {
  const result = VolumeSchema.safeParse(volume);
  if (!result.success) {
    const id = String((volume as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}

function assertReadableChapter(chapter: Chapter, context: string): void {
  const result = ChapterSchema.safeParse(chapter);
  if (!result.success) {
    const id = String((chapter as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
