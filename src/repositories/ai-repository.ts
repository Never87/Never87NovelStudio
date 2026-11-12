import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import {
  AiGlobalConfigSchema,
  AiModelSchema,
  AiProviderSchema,
  AiTaskConfigSchema,
} from '@/schemas/ai';
import type { AiGlobalConfig, AiModel, AiProvider, AiTaskConfig } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for AI configuration (P5).
 *
 * Pure persistence only — every read and write is Zod-validated, exactly like
 * the other repositories. Business rules (single default per provider, cascade
 * of models with their provider, task fallback) live in `AiConfigService`.
 *
 * Security note: this layer stores API keys verbatim because IndexedDB has no
 * protected keystore in the browser. It NEVER logs record contents.
 */
export class AiRepository {
  private readonly providerTable: Table<AiProvider, string>;
  private readonly modelTable: Table<AiModel, string>;
  private readonly taskTable: Table<AiTaskConfig, string>;
  private readonly globalTable: Table<AiGlobalConfig, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.providerTable = database.aiProviders;
    this.modelTable = database.aiModels;
    this.taskTable = database.aiTaskConfigs;
    this.globalTable = database.aiGlobalConfig;
  }

  /* ------------------------------ Providers ------------------------------ */

  /** Every provider, ordered by creation time (oldest first). */
  async listProviders(): Promise<AiProvider[]> {
    let rows: AiProvider[];
    try {
      rows = await this.providerTable.toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list AI providers', error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, AiProviderSchema, `Failed to read AI provider (record at position ${index})`),
    );
    return rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  }

  async getProvider(id: string): Promise<AiProvider | null> {
    let row: AiProvider | undefined;
    try {
      row = await this.providerTable.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read AI provider "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, AiProviderSchema, `Failed to read AI provider "${id}"`);
    return row;
  }

  async createProvider(provider: AiProvider): Promise<AiProvider> {
    const validated = validate(provider, AiProviderSchema, 'AI provider');
    try {
      await this.providerTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create AI provider "${provider.id}"`, error);
    }
  }

  async putProvider(provider: AiProvider): Promise<AiProvider> {
    const validated = validate(provider, AiProviderSchema, 'AI provider');
    try {
      await this.providerTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save AI provider "${provider.id}"`, error);
    }
  }

  async deleteProvider(id: string): Promise<void> {
    try {
      await this.providerTable.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete AI provider "${id}"`, error);
    }
  }

  /* -------------------------------- Models ------------------------------- */

  /** Every model, ordered by creation time (oldest first). */
  async listModels(): Promise<AiModel[]> {
    let rows: AiModel[];
    try {
      rows = await this.modelTable.toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list AI models', error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, AiModelSchema, `Failed to read AI model (record at position ${index})`),
    );
    return rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  }

  /** Models belonging to one provider. */
  async listModelsByProvider(providerId: string): Promise<AiModel[]> {
    let rows: AiModel[];
    try {
      rows = await this.modelTable.where('providerId').equals(providerId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list models of provider "${providerId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, AiModelSchema, `Failed to read AI model (record at position ${index})`),
    );
    return rows.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt));
  }

  async getModel(id: string): Promise<AiModel | null> {
    let row: AiModel | undefined;
    try {
      row = await this.modelTable.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read AI model "${id}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, AiModelSchema, `Failed to read AI model "${id}"`);
    return row;
  }

  async createModel(model: AiModel): Promise<AiModel> {
    const validated = validate(model, AiModelSchema, 'AI model');
    try {
      await this.modelTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create AI model "${model.id}"`, error);
    }
  }

  async putModel(model: AiModel): Promise<AiModel> {
    const validated = validate(model, AiModelSchema, 'AI model');
    try {
      await this.modelTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save AI model "${model.id}"`, error);
    }
  }

  async deleteModel(id: string): Promise<void> {
    try {
      await this.modelTable.delete(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete AI model "${id}"`, error);
    }
  }

  /** Deletes every model of a provider. Used by the provider cascade. */
  async deleteModelsByProvider(providerId: string): Promise<number> {
    try {
      return await this.modelTable.where('providerId').equals(providerId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete the models of provider "${providerId}"`, error);
    }
  }

  /* --------------------------- Task assignments -------------------------- */

  /** Every task assignment row. */
  async listTaskConfigs(): Promise<AiTaskConfig[]> {
    let rows: AiTaskConfig[];
    try {
      rows = await this.taskTable.toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list AI task configurations', error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, AiTaskConfigSchema, `Failed to read AI task config (record at position ${index})`),
    );
    return rows;
  }

  async putTaskConfig(config: AiTaskConfig): Promise<AiTaskConfig> {
    const validated = validate(config, AiTaskConfigSchema, 'AI task config');
    try {
      await this.taskTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save the AI task config "${config.task}"`, error);
    }
  }

  async deleteTaskConfig(task: string): Promise<void> {
    try {
      await this.taskTable.delete(task);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete the AI task config "${task}"`, error);
    }
  }

  /**
   * Clears every task assignment pointing at a model.
   *
   * Called when a model is deleted so no task keeps a dangling `modelId`
   * (the "unavailable model" case must fall back to the default, not crash).
   */
  async clearTaskAssignmentsForModel(modelId: string): Promise<number> {
    try {
      return await this.taskTable
        .toCollection()
        .modify((row) => {
          if (row.modelId === modelId) row.modelId = null;
        });
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to clear task assignments for model "${modelId}"`, error);
    }
  }

  /* ------------------------------ Global row ----------------------------- */

  async getGlobalConfig(): Promise<AiGlobalConfig | null> {
    let row: AiGlobalConfig | undefined;
    try {
      row = await this.globalTable.get('global');
    } catch (error) {
      throw new ProjectRepositoryError('Failed to read the global AI configuration', error);
    }
    if (row === undefined) return null;
    assertReadable(row, AiGlobalConfigSchema, 'Failed to read the global AI configuration');
    return row;
  }

  async putGlobalConfig(config: AiGlobalConfig): Promise<AiGlobalConfig> {
    const validated = validate(config, AiGlobalConfigSchema, 'Global AI config');
    try {
      await this.globalTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError('Failed to save the global AI configuration', error);
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
