import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { WritingActivitySchema } from '@/schemas/writing-activity';
import type { WritingActivity } from '@/schemas/writing-activity';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for the writing-activity ledger (Dashboard fix — Round 1).
 *
 * One row per `(projectId, dateKey)` where `dateKey` is a local calendar day.
 * `wordsWritten` accumulates the net positive word delta a project's manuscript
 * gained that day. Pure persistence: writes validated, reads validated back;
 * aggregation (streak, weekly totals) belongs to `WritingStatsService`.
 */
export class WritingActivityRepository {
  private readonly table: Table<WritingActivity, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.writingActivity;
  }

  /** The rollup row for a project on a specific local day, or `null`. */
  async getByProjectAndDate(projectId: string, dateKey: string): Promise<WritingActivity | null> {
    let row: WritingActivity | undefined;
    try {
      row = await this.table.where('[projectId+dateKey]').equals([projectId, dateKey]).first();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to read activity of project "${projectId}" on "${dateKey}"`,
        error,
      );
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read activity of project "${projectId}" on "${dateKey}"`);
    return row;
  }

  /** Every activity row for a project, ascending by day. */
  async listByProject(projectId: string): Promise<WritingActivity[]> {
    let rows: WritingActivity[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list activity of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list activity of project "${projectId}" (row ${index})`),
    );
    return rows.sort((a, b) => compareDateKey(a.dateKey, b.dateKey));
  }

  /**
   * Every activity row whose `dateKey` lies in `[fromDateKey, toDateKey]`
   * (inclusive), across ALL projects. Used for the workspace streak and the
   * 7-day output chart. ISO date keys compare chronologically.
   */
  async listByDateRange(fromDateKey: string, toDateKey: string): Promise<WritingActivity[]> {
    let rows: WritingActivity[];
    try {
      rows = await this.table
        .where('dateKey')
        .between(fromDateKey, toDateKey, true, true)
        .toArray();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to list activity between "${fromDateKey}" and "${toDateKey}"`,
        error,
      );
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list activity in range (row ${index})`),
    );
    return rows.sort((a, b) => compareDateKey(a.dateKey, b.dateKey));
  }

  /** Every activity row in the store (used for a full-workspace scan). */
  async getAll(): Promise<WritingActivity[]> {
    let rows: WritingActivity[];
    try {
      rows = await this.table.toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list all writing activity', error);
    }
    rows.forEach((row, index) => assertReadable(row, `Failed to list writing activity (row ${index})`));
    return rows;
  }

  /** Inserts a NEW activity row. */
  async create(row: WritingActivity): Promise<WritingActivity> {
    const validated = validateRow(row);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create activity "${row.id}"`, error);
    }
  }

  /** Replaces an existing activity row (by primary key). */
  async put(row: WritingActivity): Promise<WritingActivity> {
    const validated = validateRow(row);
    try {
      await this.table.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save activity "${row.id}"`, error);
    }
  }

  /** Deletes every activity row of a project. Idempotent (project cascade). */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete activity of project "${projectId}"`, error);
    }
  }
}

function validateRow(row: WritingActivity): WritingActivity {
  const result = WritingActivitySchema.safeParse(row);
  if (!result.success) {
    throw new ProjectValidationError(
      `Writing activity "${String((row as { id?: unknown } | null)?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(row: WritingActivity, context: string): void {
  const result = WritingActivitySchema.safeParse(row);
  if (!result.success) {
    const id = String((row as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}

function compareDateKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
