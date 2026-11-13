import { ZodError } from 'zod';
import { createContextConfigId, createContextItemId } from '@/utils/id';
import { now } from '@/utils/date';
import type {
  ContextConfig,
  ContextItem,
  ContextLayer,
  ContextPriority,
  ContextSourceType,
} from '@/types';
import {
  DEFAULT_REQUESTED_OUTPUT_TOKENS,
  MIN_CONTEXT_BUDGET_TOKENS,
  ContextConfigSchema,
} from '@/schemas/context';
import { ContextRepository } from '@/repositories/context-repository';
import {
  ProjectRepositoryError,
  ProjectValidationError,
} from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';

/** Fields a caller may change on the per-project config. */
export interface UpdateContextConfigInput {
  budgetEnabled?: boolean;
  inputBudgetTokens?: number;
  contextWindowOverrideTokens?: number | null;
  requestedOutputTokens?: number;
  enabledLayers?: Partial<ContextConfig['enabledLayers']>;
  persistentInstructions?: string;
}

/** Fields a caller may set when adding a context item. */
export interface CreateContextItemInput {
  layer: ContextLayer;
  sourceType: ContextSourceType;
  sourceId?: string | null;
  sourceLabel?: string;
  content?: string;
  priority?: ContextPriority;
  enabled?: boolean;
  persistent?: boolean;
}

/** Fields a caller may change on an existing context item. */
export interface UpdateContextItemInput {
  sourceLabel?: string;
  content?: string;
  priority?: ContextPriority;
  enabled?: boolean;
  persistent?: boolean;
}

/** Raised for context-manager business-rule violations. */
export class ContextManagerError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ContextManagerError';
    this.cause = cause;
  }
}

/**
 * Business layer for the AI Context Manager's persisted state (P6).
 *
 * Owns the per-project config (budget + persistent instructions) and the
 * user-controlled context items (references + notes). It does NOT resolve layer
 * content — that is `ContextAssemblyService`, which reads these records plus the
 * existing project services at request time (R3).
 *
 * Note the deliberate split: nothing here copies entity data. Items reference a
 * `sourceId`, and their live content is resolved during assembly so it can never
 * go stale.
 */
export class ContextManagerService {
  private readonly repository: ContextRepository;

  constructor(repository: ContextRepository = new ContextRepository()) {
    this.repository = repository;
  }

  /* ------------------------------- Config -------------------------------- */

  /** The project's config, creating defaults on first access. */
  async getConfig(projectId: string): Promise<ContextConfig> {
    try {
      const existing = await this.repository.getConfig(projectId);
      if (existing) return existing;

      const timestamp = now();
      const created: ContextConfig = ContextConfigSchema.parse({
        id: createContextConfigId(),
        projectId,
        budgetEnabled: true,
        inputBudgetTokens: 8_000,
        contextWindowOverrideTokens: null,
        requestedOutputTokens: DEFAULT_REQUESTED_OUTPUT_TOKENS,
        enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
        persistentInstructions: '',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return await this.repository.putConfig(created);
    } catch (error) {
      throw this.wrap(error, `Failed to load context config for project "${projectId}"`);
    }
  }

  /** Applies a partial config update, validating the merged result. */
  async updateConfig(projectId: string, input: UpdateContextConfigInput): Promise<ContextConfig> {
    const existing = await this.getConfig(projectId);
    const timestamp = now();

    const merged: ContextConfig = {
      ...existing,
      ...(input.budgetEnabled !== undefined ? { budgetEnabled: input.budgetEnabled } : {}),
      ...(input.inputBudgetTokens !== undefined
        ? { inputBudgetTokens: clampBudget(input.inputBudgetTokens) }
        : {}),
      ...(input.contextWindowOverrideTokens !== undefined
        ? { contextWindowOverrideTokens: input.contextWindowOverrideTokens }
        : {}),
      ...(input.requestedOutputTokens !== undefined
        ? { requestedOutputTokens: Math.max(0, Math.floor(input.requestedOutputTokens)) }
        : {}),
      ...(input.enabledLayers !== undefined
        ? { enabledLayers: { ...existing.enabledLayers, ...input.enabledLayers } }
        : {}),
      ...(input.persistentInstructions !== undefined
        ? { persistentInstructions: input.persistentInstructions }
        : {}),
      updatedAt: timestamp,
    };

    try {
      return await this.repository.putConfig(ContextConfigSchema.parse(merged));
    } catch (error) {
      throw this.wrap(error, `Failed to update context config for project "${projectId}"`);
    }
  }

  /* -------------------------------- Items -------------------------------- */

  async listItems(projectId: string): Promise<ContextItem[]> {
    try {
      return await this.repository.listByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to load context items of project "${projectId}"`);
    }
  }

  /** Adds a context item. Reference items require a `sourceId`. */
  async createItem(projectId: string, input: CreateContextItemInput): Promise<ContextItem> {
    const isReference = isReferenceSource(input.sourceType);
    if (isReference && !input.sourceId) {
      throw new ContextManagerError(`A "${input.sourceType}" context item requires a source id.`);
    }
    if (!isReference && !input.content?.trim()) {
      throw new ContextManagerError('A note/instruction context item requires content.');
    }

    const timestamp = now();
    const item: ContextItem = {
      id: createContextItemId(),
      projectId,
      layer: input.layer,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      sourceLabel: input.sourceLabel ?? '',
      // Reference items never store a content copy (R3).
      content: isReference ? '' : (input.content ?? ''),
      priority: input.priority ?? 'normal',
      enabled: input.enabled ?? true,
      persistent: input.persistent ?? false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.repository.putItem(item);
    } catch (error) {
      throw this.wrap(error, `Failed to add context item to project "${projectId}"`);
    }
  }

  /** Updates mutable fields of an item. Reference source cannot be re-pointed. */
  async updateItem(id: string, input: UpdateContextItemInput): Promise<ContextItem> {
    const existing = await this.repository.getItem(id);
    if (!existing) throw new ContextManagerError(`Context item "${id}" was not found.`);

    const isReference = isReferenceSource(existing.sourceType);
    const merged: ContextItem = {
      ...existing,
      ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
      // A reference item's content stays empty; only notes/instructions have it.
      ...(input.content !== undefined && !isReference ? { content: input.content } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.persistent !== undefined ? { persistent: input.persistent } : {}),
      updatedAt: now(),
    };

    try {
      return await this.repository.putItem(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update context item "${id}"`);
    }
  }

  async deleteItem(id: string): Promise<void> {
    try {
      await this.repository.deleteItem(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete context item "${id}"`);
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ContextManagerError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ContextManagerError(message, error);
  }
}

/** Whether a source type points at an existing entity (reference) vs. inline text. */
export function isReferenceSource(sourceType: ContextSourceType): boolean {
  return sourceType !== 'note' && sourceType !== 'instruction';
}

function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return MIN_CONTEXT_BUDGET_TOKENS;
  return Math.max(MIN_CONTEXT_BUDGET_TOKENS, Math.floor(value));
}
