import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { GLOBAL_WRITING_GOAL_ID } from '@/schemas/writing-goal';
import type { WritingGoal } from '@/schemas/writing-goal';
import { ProjectRepositoryError } from '@/repositories/project-repository';
import { WritingGoalRepository } from '@/repositories/writing-goal-repository';
import { ProjectServiceError } from './project-service';

/** Base error for writing-goal business failures. */
export class WritingGoalServiceError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'WritingGoalServiceError';
  }
}

/**
 * Business layer for writing goals (Dashboard fix — Round 1).
 *
 * Owns the workspach-wide daily word target. This is the SINGLE source of truth
 * shared by the Dashboard "Writing Goal" card and the (future) Writing Goals
 * page: both read `getGlobalGoal()` and write `setGlobalGoal()` so the two can
 * never disagree.
 */
export class WritingGoalService {
  private readonly repository: WritingGoalRepository;

  constructor(repository: WritingGoalRepository = new WritingGoalRepository()) {
    this.repository = repository;
  }

  /** The workspace-wide goal, or `null` when none has been set yet. */
  async getGlobalGoal(): Promise<WritingGoal | null> {
    try {
      return await this.repository.getGlobal();
    } catch (error) {
      throw this.wrap(error, 'Failed to load the writing goal');
    }
  }

  /**
   * Sets (creates or updates) the workspace-wide daily word target.
   *
   * `dailyWordTarget` is validated by the schema (positive integer within the
   * allowed bounds). The id and `createdAt` are preserved across updates so the
   * goal keeps a stable identity and creation time.
   */
  async setGlobalGoal(dailyWordTarget: number): Promise<WritingGoal> {
    try {
      const existing = await this.repository.getGlobal();
      const timestamp = now();
      const goal: WritingGoal = {
        id: GLOBAL_WRITING_GOAL_ID,
        scope: 'global',
        dailyWordTarget,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      return await this.repository.put(goal);
    } catch (error) {
      throw this.wrap(error, 'Failed to save the writing goal');
    }
  }

  /** Clears the workspace-wide goal. Idempotent. */
  async clearGlobalGoal(): Promise<void> {
    try {
      await this.repository.deleteById(GLOBAL_WRITING_GOAL_ID);
    } catch (error) {
      throw this.wrap(error, 'Failed to clear the writing goal');
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new WritingGoalServiceError(`${message}: ${error.issues[0]?.message ?? 'invalid data'}`, error);
    }
    return new WritingGoalServiceError(message, error);
  }
}
