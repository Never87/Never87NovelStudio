import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { WorldSchema } from '@/schemas/world';
import type { World } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for world records.
 *
 * Pure persistence only: no id/timestamp generation, no business rules. Every
 * write is validated against `WorldSchema` first, and every read is validated
 * back, so a malformed record can never reach the Service/UI unchecked (same
 * strategy as `ProjectRepository`).
 *
 * A world is 1:1 with a project, enforced by the unique `projectId` index.
 */
export class WorldRepository {
  private readonly table: Table<World, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.worlds;
  }

  /** Returns the world owned by `projectId`, or `null` when none exists. */
  async getByProjectId(projectId: string): Promise<World | null> {
    let world: World | undefined;
    try {
      world = await this.table.where('projectId').equals(projectId).first();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to read the world of project "${projectId}"`,
        error,
      );
    }
    if (world === undefined) return null;
    assertReadableWorld(world, `Failed to read the world of project "${projectId}"`);
    return world;
  }

  /**
   * Inserts a world.
   *
   * Uses `add()` so an existing id — or a second world for the same project
   * (unique `projectId` index) — is never silently overwritten.
   */
  async create(world: World): Promise<World> {
    const validated = validateWorld(world);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to create the world "${world.id}" for project "${world.projectId}"`,
        error,
      );
    }
  }

  /** Replaces an existing world. Fails when the id does not exist. */
  async update(world: World): Promise<World> {
    const validated = validateWorld(world);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectRepositoryError(`World "${validated.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update world "${world.id}"`, error);
    }
  }

  /**
   * Deletes the world of `projectId`, if any.
   *
   * Idempotent by design: the caller is usually cascade cleanup, where "there
   * was nothing to delete" is a success, not an error.
   *
   * @returns the number of records removed (0 or 1).
   */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete the world of project "${projectId}"`,
        error,
      );
    }
  }
}

/** Validates a world before a write, preserving the Zod error as a cause. */
function validateWorld(world: World): World {
  const result = WorldSchema.safeParse(world);
  if (!result.success) {
    throw new ProjectValidationError(
      `World "${String(world?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

/** Validates a world READ from the database; never returns malformed data. */
function assertReadableWorld(world: World, context: string): void {
  const result = WorldSchema.safeParse(world);
  if (!result.success) {
    const id = String((world as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
