import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { CoverAssetSchema } from '@/schemas/cover-asset';
import type { CoverAsset } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for stored cover images (P9 Batch D — Book Covers).
 *
 * Pure persistence, like every other repository: writes are validated against
 * `CoverAssetSchema`, reads are validated back. No business rules (limits,
 * current-cover selection, project `cover` reference updates) live here — those
 * belong to `CoverService`.
 *
 * ## Why `get` returns metadata + bytes together
 *
 * A cover asset is a small number of rows per project (one primary + a few
 * variants), so a full table scan per project is cheap. We return the Blob with
 * the record so callers can hand the bytes straight to a writer (EPUB/PDF) or an
 * object URL. The list view ignores `data` and only reads the denormalised
 * metadata (mimeType, width, height, byteSize).
 */
export class CoverRepository {
  private readonly table: Table<CoverAsset, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.coverAssets;
  }

  async getById(id: string): Promise<CoverAsset | null> {
    let row: CoverAsset | undefined;
    try {
      row = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read cover asset "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read cover asset "${id}"`);
    return row;
  }

  /** Every cover of a project, newest first (the primary is not special-cased here). */
  async listByProjectId(projectId: string): Promise<CoverAsset[]> {
    let rows: CoverAsset[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list cover assets of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list cover assets of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(sortByCreatedDesc);
  }

  /** Inserts a cover asset. `add()` so an existing id is never silently overwritten. */
  async create(asset: CoverAsset): Promise<CoverAsset> {
    const validated = validateAsset(asset);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create cover asset "${asset.id}"`, error);
    }
  }

  /** Deletes a cover asset. Fails when it does not exist. */
  async delete(id: string): Promise<void> {
    try {
      const existing = await this.table.get(id);
      if (!existing) throw new ProjectRepositoryError(`Cover asset "${id}" was not found`);
      await this.table.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete cover asset "${id}"`, error);
    }
  }

  /** Deletes every cover of a project (project-delete cascade). Idempotent. */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete cover assets of project "${projectId}"`, error);
    }
  }
}

/** Newest first, id-stable on ties (deterministic ordering). */
function sortByCreatedDesc(a: CoverAsset, b: CoverAsset): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
  return b.createdAt - a.createdAt;
}

function validateAsset(asset: CoverAsset): CoverAsset {
  const result = CoverAssetSchema.safeParse(asset);
  if (!result.success) {
    throw new ProjectValidationError(
      `Cover asset "${String(asset?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(asset: CoverAsset, context: string): void {
  const result = CoverAssetSchema.safeParse(asset);
  if (!result.success) {
    const id = String((asset as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
