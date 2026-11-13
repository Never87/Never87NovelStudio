import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ContextConfigSchema, ContextItemSchema } from '@/schemas/context';
import type { ContextConfig, ContextItem } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for the AI Context Manager (P6).
 *
 * Stores ONLY references (entity ids) and user-authored content — never copies
 * of whole project entities (R3). The referenced content is resolved through the
 * existing services during assembly, so an edited character is always reflected.
 */
export class ContextRepository {
  private readonly itemTable: Table<ContextItem, string>;
  private readonly configTable: Table<ContextConfig, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.itemTable = database.contextItems;
    this.configTable = database.contextConfigs;
  }

  /* ------------------------------- Config -------------------------------- */

  async getConfig(projectId: string): Promise<ContextConfig | null> {
    let row: ContextConfig | undefined;
    try {
      row = await this.configTable.where('projectId').equals(projectId).first();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read context config for project "${projectId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, ContextConfigSchema, `Failed to read context config for project "${projectId}"`);
    return row;
  }

  async putConfig(config: ContextConfig): Promise<ContextConfig> {
    const validated = validate(config, ContextConfigSchema, 'Context config');
    try {
      await this.configTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save context config "${config.id}"`, error);
    }
  }

  /* -------------------------------- Items -------------------------------- */

  async listByProject(projectId: string): Promise<ContextItem[]> {
    let rows: ContextItem[];
    try {
      rows = await this.itemTable.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list context items for project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, ContextItemSchema, `Failed to read context item (record at position ${index})`),
    );
    return rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  }

  async getItem(id: string): Promise<ContextItem | null> {
    let row: ContextItem | undefined;
    try {
      row = await this.itemTable.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read context item "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, ContextItemSchema, `Failed to read context item "${id}"`);
    return row;
  }

  async putItem(item: ContextItem): Promise<ContextItem> {
    const validated = validate(item, ContextItemSchema, 'Context item');
    try {
      await this.itemTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save context item "${item.id}"`, error);
    }
  }

  async deleteItem(id: string): Promise<void> {
    try {
      await this.itemTable.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete context item "${id}"`, error);
    }
  }

  /** Deletes every context item + config of a project (cascade on project delete). */
  async deleteAllByProject(projectId: string): Promise<void> {
    try {
      await this.itemTable.where('projectId').equals(projectId).delete();
      await this.configTable.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete context data for project "${projectId}"`, error);
    }
  }
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
