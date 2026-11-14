import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ProjectSnapshotSchema } from '@/schemas/snapshot';
import type { ProjectSnapshot } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for project snapshots (P9 Batch 3-1).
 *
 * Pure persistence only, mirroring every other repository:
 *   - every WRITE is validated against `ProjectSnapshotSchema` before it lands;
 *   - every READ is re-validated, so a corrupt/tampered row can never re-enter
 *     the business layer or UI;
 *   - errors keep their original `cause` (Dexie/Zod) for diagnosability.
 *
 * ## Scope guarantees
 *
 *   - Queries are ALWAYS scoped by `projectId` (`listByProject`,
 *     `deleteByProjectId`), so one project can never see or delete another's
 *     snapshots.
 *   - This repository touches ONLY the `projectSnapshots` table. It never
 *     reads or writes a project-owned business collection, so it can never
 *     mutate project data — deleting a snapshot has no effect on the project.
 *
 * Snapshots are IMMUTABLE: there is no `update()`. A capture is a single
 * `add()`, so a duplicate id fails loudly instead of silently overwriting a
 * stored payload. (Business capture/restore logic — which builds the payload
 * with the transfer layer and, later, restores atomically — belongs to the
 * B3-2 service, not here.)
 */
export class SnapshotRepository {
  private readonly table: Table<ProjectSnapshot, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.projectSnapshots;
  }

  /* ------------------------------- Reads --------------------------------- */

  /** Reads one snapshot by id, or `null` when it does not exist. */
  async getById(snapshotId: string): Promise<ProjectSnapshot | null> {
    let row: ProjectSnapshot | undefined;
    try {
      row = await this.table.get(snapshotId);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read snapshot "${snapshotId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read snapshot "${snapshotId}"`);
    return row;
  }

  /**
   * Every snapshot of one project, NEWEST first.
   *
   * Ordered explicitly (createdAt desc, then id desc) so the contract does not
   * depend on IndexedDB's natural order and ties are deterministic. Strictly
   * scoped: only rows whose `projectId` equals the argument are returned.
   */
  async listByProject(projectId: string): Promise<ProjectSnapshot[]> {
    let rows: ProjectSnapshot[];
    try {
      rows = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list snapshots of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list snapshots of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(compareSnapshots);
  }

  /** Number of snapshots captured for a project. */
  async countByProject(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).count();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to count snapshots of project "${projectId}"`,
        error,
      );
    }
  }

  /* ------------------------------- Writes -------------------------------- */

  /**
   * Persists a new snapshot.
   *
   * Uses `add()` (never `put()`): snapshots are immutable, so an existing id
   * must fail loudly rather than silently replace a stored payload. Returns the
   * validated record that was written.
   */
  async create(snapshot: ProjectSnapshot): Promise<ProjectSnapshot> {
    const validated = validate(snapshot);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create snapshot "${snapshot.id}"`, error);
    }
  }

  /* ------------------------------- Deletes ------------------------------- */

  /**
   * Deletes a single snapshot by id. Idempotent (deleting a missing id is a
   * no-op). Never touches any other table, so project data is unaffected.
   */
  async deleteById(snapshotId: string): Promise<void> {
    try {
      await this.table.delete(snapshotId);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete snapshot "${snapshotId}"`, error);
    }
  }

  /**
   * Deletes every snapshot of one project. Idempotent. Scoped strictly by
   * `projectId`, so another project's snapshots are never touched.
   *
   * Used by the project-deletion cascade. Returns the number removed.
   */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete the snapshots of project "${projectId}"`,
        error,
      );
    }
  }
}

/** Newest first; ties broken by id so the order is deterministic. */
function compareSnapshots(a: ProjectSnapshot, b: ProjectSnapshot): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function validate(snapshot: ProjectSnapshot): ProjectSnapshot {
  const result = ProjectSnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    throw new ProjectValidationError(
      `Snapshot "${String(snapshot?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(snapshot: ProjectSnapshot, context: string): void {
  const result = ProjectSnapshotSchema.safeParse(snapshot);
  if (!result.success) {
    const id = String((snapshot as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
