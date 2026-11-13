import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { KnowledgeEntrySchema } from '@/schemas/knowledge';
import type { KnowledgeEntry } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for the Knowledge Base (P7).
 *
 * Pure persistence: no id/timestamp derivation, no search logic. Writes are
 * validated against `KnowledgeEntrySchema`, reads are validated back (same
 * strategy as every other repository in the app).
 *
 * The `[projectId+sourceKey]` compound index backs the idempotent-import lookup
 * (`getBySourceKey`): importing the same entity twice finds the existing row and
 * updates it instead of creating a duplicate.
 */
export class KnowledgeRepository {
  private readonly table: Table<KnowledgeEntry, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.knowledgeEntries;
  }

  /**
   * The underlying Dexie table, exposed ONLY so a composing service (Project
   * Integration) can include it in a shared transaction scope. All reads/writes
   * still go through the validated methods above.
   */
  get dexieTable(): Table<KnowledgeEntry, string> {
    return this.table;
  }

  async getById(id: string): Promise<KnowledgeEntry | null> {
    let row: KnowledgeEntry | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read knowledge entry "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read knowledge entry "${id}"`);
    return row;
  }

  /** All entries of `projectId`, ordered by most recently updated. */
  async getByProjectId(projectId: string): Promise<KnowledgeEntry[]> {
    let rows: KnowledgeEntry[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list knowledge entries of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list knowledge entries of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(sortByUpdatedDesc);
  }

  /** Finds an entry by its stable source key within a project (idempotent import). */
  async getBySourceKey(projectId: string, sourceKey: string): Promise<KnowledgeEntry | null> {
    let row: KnowledgeEntry | undefined;
    try {
      row = await this.table.where('[projectId+sourceKey]').equals([projectId, sourceKey]).first();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to look up knowledge entry by source key "${sourceKey}"`,
        error,
      );
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read knowledge entry by source key "${sourceKey}"`);
    return row;
  }

  /** Inserts an entry. Uses `add()` so an existing id is never silently overwritten. */
  async create(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    const validated = validateEntry(entry);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create knowledge entry "${entry.id}"`, error);
    }
  }

  /** Replaces an existing entry. Fails when the id does not exist. */
  async update(entry: KnowledgeEntry): Promise<KnowledgeEntry> {
    const validated = validateEntry(entry);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectRepositoryError(`Knowledge entry "${validated.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update knowledge entry "${entry.id}"`, error);
    }
  }

  /** Deletes an entry. Fails when it does not exist. */
  async delete(id: string): Promise<void> {
    try {
      const existing = await this.table.get(id);
      if (!existing) {
        throw new ProjectRepositoryError(`Knowledge entry "${id}" was not found`);
      }
      await this.table.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete knowledge entry "${id}"`, error);
    }
  }

  /** Deletes every entry of a project (cascade on project delete). Idempotent. */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete knowledge entries of project "${projectId}"`, error);
    }
  }
}

/** Most recently updated first, id-stable on ties. */
function sortByUpdatedDesc(a: KnowledgeEntry, b: KnowledgeEntry): number {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}

function validateEntry(entry: KnowledgeEntry): KnowledgeEntry {
  const result = KnowledgeEntrySchema.safeParse(entry);
  if (!result.success) {
    throw new ProjectValidationError(
      `Knowledge entry "${String(entry?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(entry: KnowledgeEntry, context: string): void {
  const result = KnowledgeEntrySchema.safeParse(entry);
  if (!result.success) {
    const id = String((entry as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
