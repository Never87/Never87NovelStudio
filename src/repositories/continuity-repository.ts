import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ContinuityFactSchema } from '@/schemas/continuity';
import type { ContinuityFact } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for continuity facts (P7).
 *
 * Pure persistence: validation on write, validation back on read. Ordering and
 * point-in-time reconstruction live in the Service (and the pure helpers in
 * `@/schemas/continuity`), NOT here.
 */
export class ContinuityRepository {
  private readonly table: Table<ContinuityFact, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.continuityFacts;
  }

  async getById(id: string): Promise<ContinuityFact | null> {
    let row: ContinuityFact | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read continuity fact "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read continuity fact "${id}"`);
    return row;
  }

  /** All facts of a project, in a stable insertion-friendly order. */
  async getByProjectId(projectId: string): Promise<ContinuityFact[]> {
    let rows: ContinuityFact[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list continuity facts of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list continuity facts of project "${projectId}" (record at position ${index})`),
    );
    // Deterministic base order; the Service applies story ordering for reconstruction.
    return rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  }

  /** Facts anchored to one chapter (used by reconstruction and per-chapter views). */
  async getByChapter(projectId: string, chapterId: string): Promise<ContinuityFact[]> {
    let rows: ContinuityFact[];
    try {
      rows = await this.table.where('[projectId+anchorChapterId]').equals([projectId, chapterId]).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to list continuity facts anchored to chapter "${chapterId}"`,
        error,
      );
    }
    rows.forEach((row) => assertReadable(row, `Failed to read continuity fact anchored to chapter "${chapterId}"`));
    return rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  }

  async create(fact: ContinuityFact): Promise<ContinuityFact> {
    const validated = validateFact(fact);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create continuity fact "${fact.id}"`, error);
    }
  }

  async update(fact: ContinuityFact): Promise<ContinuityFact> {
    const validated = validateFact(fact);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectRepositoryError(`Continuity fact "${validated.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update continuity fact "${fact.id}"`, error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const existing = await this.table.get(id);
      if (!existing) {
        throw new ProjectRepositoryError(`Continuity fact "${id}" was not found`);
      }
      await this.table.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete continuity fact "${id}"`, error);
    }
  }

  /** Deletes every fact of a project (cascade on project delete). Idempotent. */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete continuity facts of project "${projectId}"`, error);
    }
  }
}

function validateFact(fact: ContinuityFact): ContinuityFact {
  const result = ContinuityFactSchema.safeParse(fact);
  if (!result.success) {
    throw new ProjectValidationError(
      `Continuity fact "${String(fact?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(fact: ContinuityFact, context: string): void {
  const result = ContinuityFactSchema.safeParse(fact);
  if (!result.success) {
    const id = String((fact as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
