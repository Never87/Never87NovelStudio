import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { AnalysisFindingSchema } from '@/schemas/analysis';
import type { AnalysisFinding } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for story-analysis findings (P7).
 *
 * The write path validates against `AnalysisFindingSchema`, whose `evidence`
 * array has `min(1)` — so an evidence-less finding is rejected here even if a
 * caller forgot the rule. This is the storage-layer guarantee behind "every
 * finding must cite evidence".
 */
export class AnalysisRepository {
  private readonly table: Table<AnalysisFinding, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.analysisFindings;
  }

  async getById(id: string): Promise<AnalysisFinding | null> {
    let row: AnalysisFinding | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read analysis finding "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read analysis finding "${id}"`);
    return row;
  }

  /** All findings of a project, most recently updated first. */
  async getByProjectId(projectId: string): Promise<AnalysisFinding[]> {
    let rows: AnalysisFinding[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list analysis findings of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list analysis findings of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(sortByUpdatedDesc);
  }

  async create(finding: AnalysisFinding): Promise<AnalysisFinding> {
    const validated = validateFinding(finding);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create analysis finding "${finding.id}"`, error);
    }
  }

  async update(finding: AnalysisFinding): Promise<AnalysisFinding> {
    const validated = validateFinding(finding);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectRepositoryError(`Analysis finding "${validated.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update analysis finding "${finding.id}"`, error);
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const existing = await this.table.get(id);
      if (!existing) {
        throw new ProjectRepositoryError(`Analysis finding "${id}" was not found`);
      }
      await this.table.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete analysis finding "${id}"`, error);
    }
  }

  /** Deletes every finding of a project (cascade on project delete). Idempotent. */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete analysis findings of project "${projectId}"`, error);
    }
  }
}

function sortByUpdatedDesc(a: AnalysisFinding, b: AnalysisFinding): number {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}

function validateFinding(finding: AnalysisFinding): AnalysisFinding {
  const result = AnalysisFindingSchema.safeParse(finding);
  if (!result.success) {
    throw new ProjectValidationError(
      `Analysis finding "${String(finding?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(finding: AnalysisFinding, context: string): void {
  const result = AnalysisFindingSchema.safeParse(finding);
  if (!result.success) {
    const id = String((finding as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
