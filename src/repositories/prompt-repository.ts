import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import {
  PromptTemplateSchema,
  PromptTemplateVersionSchema,
} from '@/schemas/prompt';
import type { PromptTemplate, PromptTemplateVersion } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for the Prompt Engineering Center (P6).
 *
 * Pure persistence only — every read and write is Zod-validated. Business rules
 * (version creation, default uniqueness, task association, import/export) live
 * in `PromptTemplateService`. Versions live in their own append-only table so
 * history can never be accidentally rewritten by an ordinary edit (R1).
 */
export class PromptRepository {
  private readonly templateTable: Table<PromptTemplate, string>;
  private readonly versionTable: Table<PromptTemplateVersion, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.templateTable = database.promptTemplates;
    this.versionTable = database.promptTemplateVersions;
  }

  /* ------------------------------ Templates ------------------------------ */

  /** Every template of a project, oldest first. */
  async listByProject(projectId: string): Promise<PromptTemplate[]> {
    let rows: PromptTemplate[];
    try {
      rows = await this.templateTable.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list prompt templates for project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, PromptTemplateSchema, `Failed to read prompt template (record at position ${index})`),
    );
    return rows.sort(byCreatedThenId);
  }

  async getTemplate(id: string): Promise<PromptTemplate | null> {
    let row: PromptTemplate | undefined;
    try {
      row = await this.templateTable.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read prompt template "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, PromptTemplateSchema, `Failed to read prompt template "${id}"`);
    return row;
  }

  /**
   * Every template across ALL projects.
   *
   * Used only for cross-project cleanup (e.g. clearing dangling provider/model
   * preferences when an AI provider/model is deleted). Normal reads stay scoped
   * to a single project via `listByProject`.
   */
  async listAll(): Promise<PromptTemplate[]> {
    let rows: PromptTemplate[];
    try {
      rows = await this.templateTable.toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list prompt templates', error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, PromptTemplateSchema, `Failed to read prompt template (record at position ${index})`),
    );
    return rows;
  }

  async createTemplate(template: PromptTemplate): Promise<PromptTemplate> {
    const validated = validate(template, PromptTemplateSchema, 'Prompt template');
    try {
      await this.templateTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create prompt template "${template.id}"`, error);
    }
  }

  async putTemplate(template: PromptTemplate): Promise<PromptTemplate> {
    const validated = validate(template, PromptTemplateSchema, 'Prompt template');
    try {
      await this.templateTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save prompt template "${template.id}"`, error);
    }
  }

  /** Deletes a template row and (optionally) its version history. */
  async deleteTemplate(id: string, options: { deleteVersions?: boolean } = {}): Promise<void> {
    try {
      await this.templateTable.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete prompt template "${id}"`, error);
    }
    if (options.deleteVersions) {
      await this.deleteVersionsByTemplate(id);
    }
  }

  /* ------------------------------- Versions ------------------------------ */

  /** All versions of a template, newest first. */
  async listVersionsByTemplate(templateId: string): Promise<PromptTemplateVersion[]> {
    let rows: PromptTemplateVersion[];
    try {
      rows = await this.versionTable.where('templateId').equals(templateId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list versions of template "${templateId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, PromptTemplateVersionSchema, `Failed to read template version (record at position ${index})`),
    );
    return rows.sort((a, b) => b.version - a.version);
  }

  async getVersion(id: string): Promise<PromptTemplateVersion | null> {
    let row: PromptTemplateVersion | undefined;
    try {
      row = await this.versionTable.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read template version "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, PromptTemplateVersionSchema, `Failed to read template version "${id}"`);
    return row;
  }

  /** The highest existing version number for a template (0 when none). */
  async getMaxVersion(templateId: string): Promise<number> {
    const versions = await this.listVersionsByTemplate(templateId);
    return versions.length > 0 ? versions[0].version : 0;
  }

  async createVersion(version: PromptTemplateVersion): Promise<PromptTemplateVersion> {
    const validated = validate(version, PromptTemplateVersionSchema, 'Prompt template version');
    try {
      await this.versionTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to append template version "${version.id}"`, error);
    }
  }

  async deleteVersionsByTemplate(templateId: string): Promise<number> {
    try {
      return await this.versionTable.where('templateId').equals(templateId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete versions of template "${templateId}"`, error);
    }
  }

  /** Deletes every prompt template + version of a project (cascade on project delete). */
  async deleteAllByProject(projectId: string): Promise<void> {
    try {
      await this.versionTable.where('projectId').equals(projectId).delete();
      await this.templateTable.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete prompt templates for project "${projectId}"`, error);
    }
  }
}

function byCreatedThenId(a: { createdAt: number; id: string }, b: { createdAt: number; id: string }): number {
  return a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt;
}

function validate<T>(value: T, schema: { safeParse: (v: unknown) => any }, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const id = String((value as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectValidationError(`${label} "${id}" is invalid and was not written`, result.error.issues, result.error);
  }
  return result.data as T;
}

function assertReadable<T>(value: T, schema: { safeParse: (v: unknown) => any }, context: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const id = String((value as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}
