import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { NarrativePlanSchema } from '@/schemas/narrative';
import type { NarrativePlan } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for narrative plans.
 *
 * Pure persistence only: no id/timestamp generation, no business rules. Every
 * write is validated against `NarrativePlanSchema` first, and every read is
 * validated back, so a malformed record can never reach the Service/UI
 * unchecked (same strategy as `WorldRepository`).
 *
 * A narrative plan is 1:1 with a project, enforced by the unique `projectId`
 * index (see `src/db/database.ts`, version 3).
 */
export class NarrativeRepository {
  private readonly table: Table<NarrativePlan, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.narrativePlans;
  }

  /** Returns the narrative plan of `projectId`, or `null` when none exists. */
  async getByProjectId(projectId: string): Promise<NarrativePlan | null> {
    let plan: NarrativePlan | undefined;
    try {
      plan = await this.table.where('projectId').equals(projectId).first();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to read the narrative plan of project "${projectId}"`,
        error,
      );
    }
    if (plan === undefined) return null;
    assertReadablePlan(plan, `Failed to read the narrative plan of project "${projectId}"`);
    return plan;
  }

  /**
   * Inserts a plan.
   *
   * Uses `add()` so an existing id — or a second plan for the same project
   * (unique `projectId` index) — is never silently overwritten.
   */
  async create(plan: NarrativePlan): Promise<NarrativePlan> {
    const validated = validatePlan(plan);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to create the narrative plan "${plan.id}" for project "${plan.projectId}"`,
        error,
      );
    }
  }

  /** Replaces an existing plan. Fails when the id does not exist. */
  async update(plan: NarrativePlan): Promise<NarrativePlan> {
    const validated = validatePlan(plan);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectRepositoryError(`Narrative plan "${validated.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update narrative plan "${plan.id}"`, error);
    }
  }

  /**
   * Deletes the narrative plan of `projectId`, if any.
   *
   * Idempotent by design: the caller is usually cascade cleanup, where "there
   * was nothing to delete" is a success, not an error.
   *
   * @returns the number of records removed (0 or 1).
   */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete the narrative plan of project "${projectId}"`,
        error,
      );
    }
  }
}

/** Validates a plan before a write, preserving the Zod error as a cause. */
function validatePlan(plan: NarrativePlan): NarrativePlan {
  const result = NarrativePlanSchema.safeParse(plan);
  if (!result.success) {
    throw new ProjectValidationError(
      `Narrative plan "${String(plan?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

/** Validates a plan READ from the database; never returns malformed data. */
function assertReadablePlan(plan: NarrativePlan, context: string): void {
  const result = NarrativePlanSchema.safeParse(plan);
  if (!result.success) {
    const id = String((plan as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
