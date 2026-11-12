import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createAiModelId, createAiProviderId } from '@/utils/id';
import {
  AI_TASK_KINDS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  DEFAULT_TIMEOUT_MS,
  GLOBAL_AI_CONFIG_ID,
} from '@/types';
import type {
  AiGlobalConfig,
  AiModel,
  AiProvider,
  AiProviderType,
  AiTaskConfig,
  AiTaskKind,
} from '@/types';
import { AiRepository } from '@/repositories/ai-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { getAdapter } from './ai/adapter-registry';
import { AiError } from './ai/ai-errors';

/** Input to create a provider. Timestamps and id are assigned here. */
export interface CreateProviderInput {
  name: string;
  providerType: AiProviderType;
  baseUrl?: string;
  apiKey: string;
  customHeaders?: Array<{ name: string; value: string }>;
  enabled?: boolean;
}

/** Input to update a provider (all fields optional, partial merge). */
export type UpdateProviderInput = Partial<CreateProviderInput>;

/** Input to create a model. */
export interface CreateModelInput {
  providerId: string;
  modelId: string;
  displayName: string;
  enabled?: boolean;
  isDefault?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

/** Input to update a model. */
export type UpdateModelInput = Partial<Omit<CreateModelInput, 'providerId'>>;

/** Raised when a provider or model referenced by an operation is missing. */
export class AiConfigNotFoundError extends ProjectRepositoryError {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigNotFoundError';
  }
}

/** Raised when an operation would violate an AI-config business rule. */
export class AiConfigError extends ProjectRepositoryError {
  constructor(message: string) {
    super(message);
    this.name = 'AiConfigError';
  }
}

/**
 * Business layer for AI configuration (P5).
 *
 * Owns ids, timestamps, defaults, and the cross-entity rules that must hold:
 *   - a model's provider must exist (and models cascade-delete with it);
 *   - at most ONE default model per provider;
 *   - at most ONE global default model;
 *   - deleting a model clears every task assignment that pointed at it, so a
 *     task never references a dangling model.
 *
 * It performs NO network calls (that is `AiService`) and no React (that is the
 * hooks). This keeps config correctness testable without a browser.
 */
export class AiConfigService {
  private readonly repository: AiRepository;

  constructor(repository: AiRepository = new AiRepository()) {
    this.repository = repository;
  }

  /* ------------------------------ Providers ------------------------------ */

  async listProviders(): Promise<AiProvider[]> {
    return this.repository.listProviders();
  }

  async getProvider(id: string): Promise<AiProvider | null> {
    return this.repository.getProvider(id);
  }

  /** Validates a prospective provider (shape + adapter config) before saving. */
  validateProviderInput(input: CreateProviderInput): string[] {
    const adapter = getAdapter(input.providerType);
    const result = adapter.validateConfig({
      providerType: input.providerType,
      baseUrl: (input.baseUrl ?? '').trim(),
      apiKey: input.apiKey ?? '',
      customHeaders: (input.customHeaders ?? []).map((header) => ({
        name: header.name ?? '',
        value: header.value ?? '',
      })),
    });
    return result.problems;
  }

  async createProvider(input: CreateProviderInput): Promise<AiProvider> {
    const problems = this.validateProviderInput(input);
    if (problems.length > 0) {
      throw new AiConfigError(`Cannot save this provider: ${problems.join(' ')}`);
    }

    const timestamp = now();
    const provider: AiProvider = {
      id: createAiProviderId(),
      name: input.name.trim(),
      providerType: input.providerType,
      baseUrl: (input.baseUrl ?? '').trim(),
      apiKey: input.apiKey ?? '',
      customHeaders: (input.customHeaders ?? []).map((header) => ({
        name: header.name.trim(),
        value: header.value,
      })),
      enabled: input.enabled ?? true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.repository.createProvider(provider);
    } catch (error) {
      throw this.wrap(error, 'Failed to create the AI provider');
    }
  }

  async updateProvider(id: string, input: UpdateProviderInput): Promise<AiProvider> {
    const existing = await this.repository.getProvider(id);
    if (!existing) {
      throw new AiConfigNotFoundError(`AI provider "${id}" was not found.`);
    }

    const merged: AiProvider = {
      ...existing,
      name: input.name !== undefined ? input.name.trim() : existing.name,
      providerType: input.providerType ?? existing.providerType,
      baseUrl: input.baseUrl !== undefined ? input.baseUrl.trim() : existing.baseUrl,
      apiKey: input.apiKey !== undefined ? input.apiKey : existing.apiKey,
      customHeaders:
        input.customHeaders !== undefined
          ? input.customHeaders.map((header) => ({ name: header.name.trim(), value: header.value }))
          : existing.customHeaders,
      enabled: input.enabled ?? existing.enabled,
      updatedAt: now(),
    };

    const problems = this.validateProviderInput(merged);
    if (problems.length > 0) {
      throw new AiConfigError(`Cannot save this provider: ${problems.join(' ')}`);
    }

    try {
      return await this.repository.putProvider(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update the AI provider "${id}"`);
    }
  }

  /** Toggles a provider's enabled flag. */
  async setProviderEnabled(id: string, enabled: boolean): Promise<AiProvider> {
    return this.updateProvider(id, { enabled });
  }

  /**
   * Deletes a provider and EVERYTHING that depends on it.
   *
   * Models are removed first, and every task assigned to one of those models is
   * cleared, so the task falls back to the global default instead of pointing
   * at a model whose provider is gone. The global default is cleared too if it
   * referenced a deleted model.
   */
  async deleteProvider(id: string): Promise<void> {
    const models = await this.repository.listModelsByProvider(id);
    for (const model of models) {
      await this.clearAssignmentsForModel(model.id);
    }
    await this.repository.deleteModelsByProvider(id);

    const global = await this.repository.getGlobalConfig();
    if (global && models.some((model) => model.id === global.defaultModelId)) {
      await this.repository.putGlobalConfig({
        ...global,
        defaultModelId: null,
        updatedAt: now(),
      });
    }

    await this.repository.deleteProvider(id);
  }

  /* -------------------------------- Models ------------------------------- */

  async listModels(): Promise<AiModel[]> {
    return this.repository.listModels();
  }

  /** Lists a single provider's models (used by the UI and the transporter). */
  async listModelsByProvider(providerId: string): Promise<AiModel[]> {
    return this.repository.listModelsByProvider(providerId);
  }

  async getModel(id: string): Promise<AiModel | null> {
    return this.repository.getModel(id);
  }

  async createModel(input: CreateModelInput): Promise<AiModel> {
    const provider = await this.repository.getProvider(input.providerId);
    if (!provider) {
      throw new AiConfigNotFoundError(
        `Cannot add a model: provider "${input.providerId}" does not exist.`,
      );
    }

    const timestamp = now();
    const model: AiModel = {
      id: createAiModelId(),
      providerId: input.providerId,
      modelId: input.modelId.trim(),
      displayName: input.displayName.trim(),
      enabled: input.enabled ?? true,
      isDefault: input.isDefault ?? false,
      temperature: input.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const saved = await this.repository.createModel(model).catch((error: unknown) => {
      throw this.wrap(error, 'Failed to create the AI model');
    });

    // Enforce "one default per provider": making this model the default clears
    // the flag on its siblings.
    if (saved.isDefault) {
      await this.setProviderDefaultModel(provider.id, saved.id);
      return (await this.repository.getModel(saved.id)) ?? saved;
    }
    return saved;
  }

  async updateModel(id: string, input: UpdateModelInput): Promise<AiModel> {
    const existing = await this.repository.getModel(id);
    if (!existing) {
      throw new AiConfigNotFoundError(`AI model "${id}" was not found.`);
    }

    const merged: AiModel = {
      ...existing,
      modelId: input.modelId !== undefined ? input.modelId.trim() : existing.modelId,
      displayName: input.displayName !== undefined ? input.displayName.trim() : existing.displayName,
      enabled: input.enabled ?? existing.enabled,
      isDefault: input.isDefault ?? existing.isDefault,
      temperature: input.temperature ?? existing.temperature,
      maxTokens: input.maxTokens ?? existing.maxTokens,
      timeout: input.timeout ?? existing.timeout,
      updatedAt: now(),
    };

    const saved = await this.repository.putModel(merged).catch((error: unknown) => {
      throw this.wrap(error, `Failed to update the AI model "${id}"`);
    });

    if (saved.isDefault) {
      await this.setProviderDefaultModel(saved.providerId, saved.id);
      return (await this.repository.getModel(saved.id)) ?? saved;
    }
    return saved;
  }

  async setModelEnabled(id: string, enabled: boolean): Promise<AiModel> {
    return this.updateModel(id, { enabled });
  }

  /**
   * Makes a model its provider's default and clears the flag on its siblings.
   *
   * Guarantees the "at most one default per provider" invariant regardless of
   * how many models exist or in which order they were created.
   */
  async setProviderDefaultModel(providerId: string, modelId: string): Promise<void> {
    const models = await this.repository.listModelsByProvider(providerId);
    const timestamp = now();
    for (const model of models) {
      const shouldBeDefault = model.id === modelId;
      if (model.isDefault !== shouldBeDefault) {
        await this.repository.putModel({ ...model, isDefault: shouldBeDefault, updatedAt: timestamp });
      }
    }
  }

  /**
   * Deletes a model and detaches it from every task and the global default.
   *
   * Without this, a deleted model would leave `aiTaskConfigs.defaultModelId`
   * pointing at nothing — an "unavailable model" the user never chose.
   */
  async deleteModel(id: string): Promise<void> {
    await this.clearAssignmentsForModel(id);
    await this.repository.deleteModel(id);
  }

  /* --------------------------- Task assignments -------------------------- */

  /** Every task assignment plus the global default, resolved for the UI. */
  async getAssignments(): Promise<{
    global: AiGlobalConfig;
    tasks: Record<AiTaskKind, string | null>;
  }> {
    const [globalStored, taskRows] = await Promise.all([
      this.repository.getGlobalConfig(),
      this.repository.listTaskConfigs(),
    ]);

    const tasks = Object.fromEntries(
      AI_TASK_KINDS.map((task) => [task, null as string | null]),
    ) as Record<AiTaskKind, string | null>;
    for (const row of taskRows) {
      if (row.task in tasks) tasks[row.task] = row.modelId;
    }

    return {
      global: globalStored ?? { id: GLOBAL_AI_CONFIG_ID, defaultModelId: null, updatedAt: now() },
      tasks,
    };
  }

  async setGlobalDefaultModel(modelId: string | null): Promise<AiGlobalConfig> {
    if (modelId) {
      const model = await this.repository.getModel(modelId);
      if (!model) throw new AiConfigNotFoundError(`Cannot set the default: model "${modelId}" does not exist.`);
    }
    const current = await this.repository.getGlobalConfig();
    const next: AiGlobalConfig = {
      id: GLOBAL_AI_CONFIG_ID,
      defaultModelId: modelId,
      updatedAt: now(),
    };
    void current;
    return this.repository.putGlobalConfig(next);
  }

  async setTaskModel(task: AiTaskKind, modelId: string | null): Promise<AiTaskConfig> {
    if (modelId) {
      const model = await this.repository.getModel(modelId);
      if (!model) {
        throw new AiConfigNotFoundError(`Cannot assign task "${task}": model "${modelId}" does not exist.`);
      }
    }
    return this.repository.putTaskConfig({ task, modelId, updatedAt: now() });
  }

  /* ------------------------------- helpers ------------------------------- */

  /** Clears every task assignment (and the global default) that points at a model. */
  private async clearAssignmentsForModel(modelId: string): Promise<void> {
    const global = await this.repository.getGlobalConfig();
    if (global && global.defaultModelId === modelId) {
      await this.repository.putGlobalConfig({ ...global, defaultModelId: null, updatedAt: now() });
    }
    const tasks = await this.repository.listTaskConfigs();
    for (const row of tasks) {
      if (row.modelId === modelId) {
        await this.repository.putTaskConfig({ ...row, modelId: null, updatedAt: now() });
      }
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof AiError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ProjectRepositoryError(message, error);
  }
}
