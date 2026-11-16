import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { WritingGoalSchema, GLOBAL_WRITING_GOAL_ID } from '@/schemas/writing-goal';
import type { WritingGoal } from '@/schemas/writing-goal';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for writing goals (Dashboard fix — Round 1).
 *
 * Pure persistence: writes are validated against `WritingGoalSchema` and reads
 * are validated back. Business rules (defaults, id/timestamp stamping) live in
 * `WritingGoalService`. The workspace-wide goal is a singleton row keyed by
 * `GLOBAL_WRITING_GOAL_ID` ('global').
 */
export class WritingGoalRepository {
  private readonly table: Table<WritingGoal, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.writingGoals;
  }

  /** The workspace-wide goal, or `null` when none has ever been set. */
  async getGlobal(): Promise<WritingGoal | null> {
    return this.getById(GLOBAL_WRITING_GOAL_ID);
  }

  /** A goal by primary key, or `null`. */
  async getById(id: string): Promise<WritingGoal | null> {
    let row: WritingGoal | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read writing goal "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read writing goal "${id}"`);
    return row;
  }

  /**
   * Inserts or replaces a goal by primary key.
   *
   * `put` (not `add`) is used because the singleton is upserted as the target
   * is edited; the service owns id/timestamps so a put never resurrects stale
   * fields unexpectedly.
   */
  async put(goal: WritingGoal): Promise<WritingGoal> {
    const validated = validateGoal(goal);
    try {
      await this.table.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save writing goal "${goal.id}"`, error);
    }
  }

  /** Deletes a goal by primary key. Idempotent. */
  async deleteById(id: string): Promise<void> {
    try {
      await this.table.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete writing goal "${id}"`, error);
    }
  }
}

function validateGoal(goal: WritingGoal): WritingGoal {
  const result = WritingGoalSchema.safeParse(goal);
  if (!result.success) {
    throw new ProjectValidationError(
      `Writing goal "${String((goal as { id?: unknown } | null)?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(goal: WritingGoal, context: string): void {
  const result = WritingGoalSchema.safeParse(goal);
  if (!result.success) {
    const id = String((goal as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}
