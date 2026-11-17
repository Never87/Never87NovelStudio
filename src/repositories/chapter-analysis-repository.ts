import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ChapterAnalysisRunSchema } from '@/schemas/chapter-analysis';
import type { ChapterAnalysisRun } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for chapter-analysis runs (P11).
 *
 * Pure persistence only, mirroring every other repository:
 *   - every WRITE is validated against `ChapterAnalysisRunSchema` before it lands;
 *   - every READ is re-validated, so a corrupt/tampered row can never re-enter
 *     the business layer or UI;
 *   - errors keep their original `cause` (Dexie/Zod) for diagnosability.
 *
 * ## Scope guarantees
 *
 *   - Every query is scoped by `projectId`, so one project can never read,
 *     update or delete another project's runs.
 *   - This repository touches ONLY the `chapterAnalysisRuns` table. It never
 *     reads or writes a project-owned business collection, so analysing a
 *     chapter can never mutate the chapter or its entities.
 *
 * ## Idempotency (fingerprint)
 *
 * `findByFingerprint` backs the "re-running an unchanged chapter is idempotent"
 * guarantee. The compound `[projectId+chapterId+contentFingerprint]` index makes
 * the lookup O(log n); the SERVICE still performs find→create inside ONE
 * transaction so two concurrent runs cannot both insert the same fingerprint.
 */
export class ChapterAnalysisRepository {
  private readonly table: Table<ChapterAnalysisRun, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.chapterAnalysisRuns;
  }

  /* ------------------------------- Reads --------------------------------- */

  /** Reads one run by id, or `null` when it does not exist. */
  async getById(id: string): Promise<ChapterAnalysisRun | null> {
    let row: ChapterAnalysisRun | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read chapter analysis "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read chapter analysis "${id}"`);
    return row;
  }

  /**
   * Every run of a project, newest first. Strictly scoped to `projectId`.
   */
  async listByProject(projectId: string): Promise<ChapterAnalysisRun[]> {
    let rows: ChapterAnalysisRun[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list chapter analyses of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list chapter analyses of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(byUpdatedDesc);
  }

  /**
   * All runs for ONE chapter of ONE project, newest first — the re-analysis
   * history. Backed by the `[projectId+chapterId]` compound index.
   */
  async listByChapter(projectId: string, chapterId: string): Promise<ChapterAnalysisRun[]> {
    let rows: ChapterAnalysisRun[];
    try {
      rows = await this.table.where('[projectId+chapterId]').equals([projectId, chapterId]).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to list chapter analyses of chapter "${chapterId}"`,
        error,
      );
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list chapter analyses of chapter "${chapterId}" (record at position ${index})`),
    );
    return rows.sort(byUpdatedDesc);
  }

  /**
   * Finds a run by its idempotency fingerprint within a (project, chapter).
   *
   * Backed by the compound `[projectId+chapterId+contentFingerprint]` index.
   * Returns the newest match (there should never be more than one when writes
   * go through the service's transactional create-if-absent).
   */
  async findByFingerprint(
    projectId: string,
    chapterId: string,
    contentFingerprint: string,
  ): Promise<ChapterAnalysisRun | null> {
    let row: ChapterAnalysisRun | undefined;
    try {
      row = await this.table
        .where('[projectId+chapterId+contentFingerprint]')
        .equals([projectId, chapterId, contentFingerprint])
        .first();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to look up chapter analysis by fingerprint "${contentFingerprint}"`,
        error,
      );
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read chapter analysis by fingerprint "${contentFingerprint}"`);
    return row;
  }

  /* ------------------------------- Writes -------------------------------- */

  /** Inserts a new run. Uses `add()` so an existing id is never overwritten. */
  async create(run: ChapterAnalysisRun): Promise<ChapterAnalysisRun> {
    const validated = validate(run);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create chapter analysis "${run.id}"`, error);
    }
  }

  /** Replaces an existing run. Fails when the id does not exist. */
  async update(run: ChapterAnalysisRun): Promise<ChapterAnalysisRun> {
    const validated = validate(run);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Chapter analysis "${validated.id}" was not found`);
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update chapter analysis "${run.id}"`, error);
    }
  }

  /**
   * Runs `fn` inside a single readwrite Dexie transaction over the analysis
   * table, so a fingerprint find→create sequence is atomic: two concurrent runs
   * cannot both observe "no existing row" and insert duplicates for the same
   * fingerprint.
   */
  async runTransaction<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.table.db.transaction('rw', this.table, fn);
    } catch (error) {
      if (isDomainError(error)) throw error;
      throw new ProjectRepositoryError('Failed to run chapter-analysis transaction', error);
    }
  }

  /* ------------------------------- Deletes ------------------------------- */

  /** Deletes one run by id. Idempotent (a missing id is a no-op). */
  async deleteById(id: string): Promise<void> {
    try {
      await this.table.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete chapter analysis "${id}"`, error);
    }
  }

  /**
   * Deletes every run of one project. Idempotent. Scoped strictly by
   * `projectId`, so another project's runs are never touched. Used by the
   * project-deletion cascade. Returns the number removed.
   */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete the chapter analyses of project "${projectId}"`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Most recently updated first; ties fall back to createdAt then id (deterministic). */
function byUpdatedDesc(a: ChapterAnalysisRun, b: ChapterAnalysisRun): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : -1;
}

/** True when `error` is a domain/business error rather than a storage failure. */
function isDomainError(error: unknown): boolean {
  if (error instanceof ProjectRepositoryError || error instanceof ProjectValidationError) return true;
  if (error instanceof Error) {
    const name = error.name;
    if (
      name === 'ProjectServiceError' ||
      name.endsWith('ServiceError') ||
      name.endsWith('ValidationError') ||
      name.endsWith('NotFoundError')
    ) {
      return true;
    }
  }
  return false;
}

function validate(run: ChapterAnalysisRun): ChapterAnalysisRun {
  const result = ChapterAnalysisRunSchema.safeParse(run);
  if (!result.success) {
    throw new ProjectValidationError(
      `Chapter analysis "${String(run?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(run: ChapterAnalysisRun, context: string): void {
  const result = ChapterAnalysisRunSchema.safeParse(run);
  if (!result.success) {
    const id = String((run as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}
