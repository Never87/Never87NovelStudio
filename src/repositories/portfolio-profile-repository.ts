import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { PortfolioProfileSchema } from '@/schemas/portfolio-profile';
import type { PortfolioProfile } from '@/schemas/portfolio-profile';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for Portfolio display profiles (P9 Batch E).
 *
 * Pure persistence: writes are validated against `PortfolioProfileSchema` and
 * reads are validated back. No business rules live here — assembling a resolved
 * `PortfolioEntry`, fallbacks and ordering belong to the service/pure module.
 *
 * One profile per project is enforced by a UNIQUE `projectId` index on the
 * `portfolioProfiles` store (see `db/database.ts` v15), so a second insert for
 * the same project fails loudly rather than creating a silent duplicate.
 */
export class PortfolioProfileRepository {
  private readonly table: Table<PortfolioProfile, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.portfolioProfiles;
  }

  /** The profile for a project, or null when none has been created. */
  async getByProjectId(projectId: string): Promise<PortfolioProfile | null> {
    let row: PortfolioProfile | undefined;
    try {
      row = await this.table.where('projectId').equals(projectId).first();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read portfolio profile of project "${projectId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, `Failed to read portfolio profile of project "${projectId}"`);
    return row;
  }

  /** Every profile in the store (used to assemble the catalog in one pass). */
  async getAll(): Promise<PortfolioProfile[]> {
    let rows: PortfolioProfile[];
    try {
      rows = await this.table.toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list portfolio profiles', error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, `Failed to list portfolio profiles (record at position ${index})`),
    );
    return rows;
  }

  /** Inserts a NEW profile. `add()` so an existing project's profile is never overwritten. */
  async create(profile: PortfolioProfile): Promise<PortfolioProfile> {
    const validated = validateProfile(profile);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create portfolio profile "${profile.id}"`, error);
    }
  }

  /** Replaces an existing profile (by primary key). Fails when it does not exist. */
  async update(profile: PortfolioProfile): Promise<PortfolioProfile> {
    const validated = validateProfile(profile);
    try {
      const existing = await this.table.get(profile.id);
      if (!existing) {
        throw new ProjectRepositoryError(`Portfolio profile "${profile.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update portfolio profile "${profile.id}"`, error);
    }
  }

  /** Deletes a project's profile, if any. Idempotent (nothing to delete = success). */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete portfolio profile of project "${projectId}"`, error);
    }
  }
}

function validateProfile(profile: PortfolioProfile): PortfolioProfile {
  const result = PortfolioProfileSchema.safeParse(profile);
  if (!result.success) {
    throw new ProjectValidationError(
      `Portfolio profile "${String(profile?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertReadable(profile: PortfolioProfile, context: string): void {
  const result = PortfolioProfileSchema.safeParse(profile);
  if (!result.success) {
    const id = String((profile as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}
