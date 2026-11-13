import { ZodError } from 'zod';
import {
  createPromptTemplateId,
  createPromptTemplateVersionId,
} from '@/utils/id';
import { now } from '@/utils/date';
import type {
  AiTaskKind,
  PromptBundleEntry,
  PromptTemplate,
  PromptTemplateVersion,
  PromptVariable,
} from '@/types';
import {
  PROMPT_BUNDLE_FORMAT,
  PROMPT_BUNDLE_VERSION,
  PromptBundleSchema,
} from '@/schemas/prompt';
import { PromptRepository } from '@/repositories/prompt-repository';
import { AiRepository } from '@/repositories/ai-repository';
import {
  ProjectRepositoryError,
  ProjectValidationError,
} from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';
import { validateTemplate, type TemplateValidationIssue } from './ai/prompt-render';
import { BUILTIN_TEMPLATES } from './ai/builtin-templates';

/** Fields a caller may set when creating a template. */
export interface CreateTemplateInput {
  name: string;
  description?: string;
  category: string;
  content: string;
  variables?: PromptVariable[];
  taskKind?: AiTaskKind | null;
  /** Optional provider preference (`prov_…`), validated if provided (R2). */
  providerId?: string | null;
  /** Optional model preference (`model_…`), validated if provided (R2). */
  modelId?: string | null;
  isDefault?: boolean;
  enabled?: boolean;
}

/** Fields a caller may change. Omitted fields are left untouched. */
export interface UpdateTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  content?: string;
  variables?: PromptVariable[];
  taskKind?: AiTaskKind | null;
  providerId?: string | null;
  modelId?: string | null;
  isDefault?: boolean;
  enabled?: boolean;
  /** Optional short note stored on the version this update creates. */
  versionLabel?: string;
}

/** Raised for prompt-template business-rule violations. */
export class PromptTemplateError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PromptTemplateError';
    this.cause = cause;
  }
}

export interface PromptImportResult {
  imported: number;
  skipped: number;
  /** Records imported under a renamed copy because the name already existed. */
  conflicted: number;
  /** Per-template outcomes, so the UI can explain what happened. */
  details: Array<{ name: string; status: 'imported' | 'skipped' | 'conflict' | 'invalid'; reason?: string }>;
}

/**
 * Business layer for the Prompt Engineering Center (P6).
 *
 * Responsibilities:
 *   - owns ids, timestamps, defaults and version creation (append-only, R1);
 *   - enforces at most ONE default template per (project, task);
 *   - validates template bodies against their declared variables;
 *   - treats provider/model as PREFERENCES only, re-validated against the local
 *     AI configuration and never used to resolve a model (R2);
 *   - imports/exports portable bundles (R6);
 *   - always project-isolated.
 *
 * It never touches Dexie directly — persistence is via `PromptRepository`.
 */
export class PromptTemplateService {
  private readonly repository: PromptRepository;
  private readonly aiRepository: AiRepository;

  constructor(
    repository: PromptRepository = new PromptRepository(),
    aiRepository: AiRepository = new AiRepository(),
  ) {
    this.repository = repository;
    this.aiRepository = aiRepository;
  }

  /* ------------------------------- Reads -------------------------------- */

  /** Every template of a project, in creation order. */
  async listTemplates(projectId: string): Promise<PromptTemplate[]> {
    try {
      return await this.repository.listByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to load prompt templates of project "${projectId}"`);
    }
  }

  async getTemplate(id: string): Promise<PromptTemplate | null> {
    try {
      return await this.repository.getTemplate(id);
    } catch (error) {
      throw this.wrap(error, `Failed to load prompt template "${id}"`);
    }
  }

  /** All versions of a template, newest first. */
  async listVersions(templateId: string): Promise<PromptTemplateVersion[]> {
    try {
      return await this.repository.listVersionsByTemplate(templateId);
    } catch (error) {
      throw this.wrap(error, `Failed to load versions of template "${templateId}"`);
    }
  }

  /** The default template for a task in a project, if one is set. */
  async getDefaultForTask(projectId: string, task: AiTaskKind): Promise<PromptTemplate | null> {
    const templates = await this.listTemplates(projectId);
    return templates.find((template) => template.taskKind === task && template.isDefault) ?? null;
  }

  /**
   * Structural validation of a template body + variables without persisting.
   * Used by the editor to show live issues and by create/update to fail fast.
   */
  validate(content: string, variables: PromptVariable[]): TemplateValidationIssue[] {
    return validateTemplate(content, variables);
  }

  /* ------------------------------- Writes ------------------------------- */

  /** Creates a template and its initial version. */
  async createTemplate(projectId: string, input: CreateTemplateInput): Promise<PromptTemplate> {
    const variables = input.variables ?? [];
    const issues = validateTemplate(input.content, variables);
    if (issues.length > 0) {
      throw new PromptTemplateError(`This template is invalid: ${issues.map((i) => i.message).join(' ')}`);
    }

    await this.assertPreferencesExist(input.providerId ?? null, input.modelId ?? null);

    const timestamp = now();
    const id = createPromptTemplateId();
    const versionId = createPromptTemplateVersionId();
    const wantsDefault = input.isDefault ?? false;

    // Enforce one default per (project, task).
    if (wantsDefault && input.taskKind) {
      await this.clearDefaultForTask(projectId, input.taskKind, id);
    }

    const template: PromptTemplate = {
      id,
      projectId,
      name: input.name,
      description: input.description ?? '',
      category: input.category,
      content: input.content,
      variables,
      taskKind: input.taskKind ?? null,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      isDefault: wantsDefault && Boolean(input.taskKind),
      enabled: input.enabled ?? true,
      currentVersionId: versionId,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const version: PromptTemplateVersion = this.toVersion(template, versionId, 1, 'created');

    try {
      await this.repository.createVersion(version);
      return await this.repository.createTemplate(template);
    } catch (error) {
      throw this.wrap(error, `Failed to create prompt template "${template.id}"`);
    }
  }

  /**
   * Updates a template, ALWAYS appending a new immutable version (R1).
   *
   * No-op updates (identical content-bearing fields) do not create a version, to
   * avoid history noise from toggling e.g. `enabled`.
   */
  async updateTemplate(id: string, input: UpdateTemplateInput): Promise<PromptTemplate> {
    const existing = await this.getTemplate(id);
    if (!existing) throw new PromptTemplateError(`Prompt template "${id}" was not found.`);

    const nextContent = input.content ?? existing.content;
    const nextVariables = input.variables ?? existing.variables;
    const issues = validateTemplate(nextContent, nextVariables);
    if (issues.length > 0) {
      throw new PromptTemplateError(`This template is invalid: ${issues.map((i) => i.message).join(' ')}`);
    }

    if (input.providerId !== undefined || input.modelId !== undefined) {
      await this.assertPreferencesExist(
        input.providerId !== undefined ? input.providerId : existing.providerId,
        input.modelId !== undefined ? input.modelId : existing.modelId,
      );
    }

    const nextTaskKind = input.taskKind !== undefined ? input.taskKind : existing.taskKind;
    let nextIsDefault = input.isDefault !== undefined ? input.isDefault : existing.isDefault;
    // A template without a task can never be the default for anything.
    if (!nextTaskKind) nextIsDefault = false;

    if (nextIsDefault && nextTaskKind) {
      await this.clearDefaultForTask(existing.projectId, nextTaskKind, id);
    }

    const contentChanged =
      nextContent !== existing.content ||
      JSON.stringify(nextVariables) !== JSON.stringify(existing.variables) ||
      (input.name ?? existing.name) !== existing.name ||
      (input.description ?? existing.description) !== existing.description ||
      (input.category ?? existing.category) !== existing.category ||
      nextTaskKind !== existing.taskKind;

    const timestamp = now();
    let template: PromptTemplate = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.variables !== undefined ? { variables: input.variables } : {}),
      ...(input.taskKind !== undefined ? { taskKind: input.taskKind } : {}),
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
      ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      isDefault: nextIsDefault,
      updatedAt: timestamp,
    };

    try {
      if (contentChanged) {
        const versionNumber = existing.version + 1;
        const versionId = createPromptTemplateVersionId();
        const version = this.toVersion(template, versionId, versionNumber, 'edited', input.versionLabel);
        await this.repository.createVersion(version);
        template = { ...template, currentVersionId: versionId, version: versionNumber };
      }
      return await this.repository.putTemplate(template);
    } catch (error) {
      throw this.wrap(error, `Failed to update prompt template "${id}"`);
    }
  }

  /**
   * Restores a historical version by APPENDING a new version that copies it.
   * History is never rewritten (R1).
   */
  async restoreVersion(id: string, versionId: string): Promise<PromptTemplate> {
    const existing = await this.getTemplate(id);
    if (!existing) throw new PromptTemplateError(`Prompt template "${id}" was not found.`);

    const target = await this.repository.getVersion(versionId);
    if (!target || target.templateId !== id) {
      throw new PromptTemplateError(`Version "${versionId}" does not belong to template "${id}".`);
    }

    const timestamp = now();
    const versionNumber = existing.version + 1;
    const newVersionId = createPromptTemplateVersionId();

    const template: PromptTemplate = {
      ...existing,
      name: target.name,
      description: target.description,
      category: target.category,
      content: target.content,
      variables: target.variables,
      taskKind: target.taskKind,
      currentVersionId: newVersionId,
      version: versionNumber,
      updatedAt: timestamp,
    };

    const version = this.toVersion(template, newVersionId, versionNumber, 'restored', `Restored v${target.version}`);

    try {
      await this.repository.createVersion(version);
      return await this.repository.putTemplate(template);
    } catch (error) {
      throw this.wrap(error, `Failed to restore version "${versionId}" of template "${id}"`);
    }
  }

  /** Duplicates a template (including a fresh first version) under a new name. */
  async duplicateTemplate(id: string, newName?: string): Promise<PromptTemplate> {
    const source = await this.getTemplate(id);
    if (!source) throw new PromptTemplateError(`Prompt template "${id}" was not found.`);
    return this.createTemplate(source.projectId, {
      name: newName ?? `${source.name} (copy)`,
      description: source.description,
      category: source.category,
      content: source.content,
      variables: source.variables.map((variable) => ({ ...variable })),
      taskKind: source.taskKind,
      providerId: source.providerId,
      modelId: source.modelId,
      // A copy is never the default — the original keeps that role.
      isDefault: false,
      enabled: source.enabled,
    });
  }

  /** Deletes a template and its entire version history. */
  async deleteTemplate(id: string): Promise<void> {
    try {
      await this.repository.deleteTemplate(id, { deleteVersions: true });
    } catch (error) {
      throw this.wrap(error, `Failed to delete prompt template "${id}"`);
    }
  }

  /* --------------------- Cross-entity preference cleanup ----------------- */

  /**
   * Clears a now-dangling MODEL preference from every template (R7).
   *
   * Called after a model is deleted. Preferences are not content, so clearing
   * them does NOT create a version — history is preserved untouched. The
   * template's task association and body remain; only the stale `modelId` (and,
   * if it referenced the deleted model's provider chain, nothing else) is removed
   * so the P5 resolver stays authoritative.
   *
   * Returns the number of templates that were updated.
   */
  async clearPreferencesForModel(modelId: string): Promise<number> {
    try {
      const templates = await this.repository.listAll();
      let updated = 0;
      for (const template of templates) {
        // A template may reference this model directly, or reference a provider
        // preference; only the direct model preference can go stale with a model.
        if (template.modelId === modelId) {
          await this.repository.putTemplate({ ...template, modelId: null, updatedAt: now() });
          updated += 1;
        }
      }
      return updated;
    } catch (error) {
      throw this.wrap(error, `Failed to clear model preference "${modelId}" from templates`);
    }
  }

  /**
   * Clears a now-dangling PROVIDER preference (and any model preference that
   * belonged to that provider) from every template (R7).
   *
   * Called after a provider is deleted. Like the model variant, this is not a
   * content change and does not append a version.
   *
   * Returns the number of templates that were updated.
   */
  async clearPreferencesForProvider(providerId: string, alsoModelIds: string[] = []): Promise<number> {
    try {
      const staleModels = new Set(alsoModelIds);
      const templates = await this.repository.listAll();
      let updated = 0;
      for (const template of templates) {
        const providerStale = template.providerId === providerId;
        const modelStale = template.modelId !== null && staleModels.has(template.modelId);
        if (providerStale || modelStale) {
          await this.repository.putTemplate({
            ...template,
            providerId: providerStale ? null : template.providerId,
            modelId: modelStale ? null : template.modelId,
            updatedAt: now(),
          });
          updated += 1;
        }
      }
      return updated;
    } catch (error) {
      throw this.wrap(error, `Failed to clear provider preference "${providerId}" from templates`);
    }
  }

  /* --------------------------- Built-in seeding ------------------------- */

  /**
   * Seeds the project's built-in templates on first use (idempotent).
   *
   * Built-in templates are ordinary, fully-editable templates created into the
   * project — they are not a hidden, immutable set.
   */
  async ensureBuiltins(projectId: string): Promise<PromptTemplate[]> {
    const existing = await this.listTemplates(projectId);
    if (existing.length > 0) return existing;

    for (const builtin of BUILTIN_TEMPLATES) {
      await this.createTemplate(projectId, {
        name: builtin.name,
        description: builtin.description,
        category: builtin.category,
        content: builtin.content,
        variables: builtin.variables.map((variable) => ({ ...variable })),
        taskKind: builtin.taskKind,
        isDefault: builtin.isDefault ?? false,
        enabled: true,
      });
    }
    return this.listTemplates(projectId);
  }

  /* ------------------------------- Export ------------------------------- */

  /** Serialises templates to a portable JSON bundle (no ids, keys or project data). */
  async exportBundle(projectId: string, templateIds?: string[]): Promise<string> {
    const templates = await this.listTemplates(projectId);
    const selected = templateIds ? templates.filter((template) => templateIds.includes(template.id)) : templates;
    const bundle = {
      format: PROMPT_BUNDLE_FORMAT,
      formatVersion: PROMPT_BUNDLE_VERSION,
      exportedAt: now(),
      templates: selected.map((template) => this.toBundleEntry(template)),
    };
    // Validated so an export never emits a bundle the importer would reject.
    return JSON.stringify(PromptBundleSchema.parse(bundle), null, 2);
  }

  /**
   * Imports templates from a bundle JSON string.
   *
   * Conflict semantics (R6) — chosen so no content is ever silently discarded:
   *   - No existing template with this name            → imported as-is.
   *   - Same name AND identical content/variables       → skipped (idempotent;
   *     re-importing the same bundle is a no-op).
   *   - Same name BUT different content/variables        → imported under a
   *     derived unique name (e.g. "Polish (imported)") and reported as a
   *     `conflict`, so the user's existing template is preserved AND the incoming
   *     content is not lost.
   *
   * Every imported copy ALWAYS receives a brand-new id (never overwrites an
   * existing record). Each entry is independently validated; a malformed entry is
   * reported as `invalid` and skipped rather than aborting the whole import.
   * Provider/model preferences are NOT carried by the bundle format, so nothing
   * referencing a non-existent local model can be imported (R2/R6).
   */
  async importBundle(projectId: string, json: string): Promise<PromptImportResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new PromptTemplateError('The file is not valid JSON.');
    }

    const bundle = PromptBundleSchema.safeParse(parsed);
    if (!bundle.success) {
      throw new PromptTemplateError('The file is not a valid prompt-template bundle.');
    }

    const details: PromptImportResult['details'] = [];
    let imported = 0;
    let skipped = 0;
    let conflicted = 0;

    // Index existing templates by normalized name so we can detect clashes and
    // decide between idempotent-skip and conflict-rename.
    const existingByName = new Map<string, PromptTemplate>();
    const existingList = await this.listTemplates(projectId);
    for (const template of existingList) {
      existingByName.set(template.name.trim().toLowerCase(), template);
    }

    for (const entry of bundle.data.templates) {
      const issues = validateTemplate(entry.content, entry.variables);
      if (issues.length > 0) {
        details.push({ name: entry.name, status: 'invalid', reason: issues.map((i) => i.message).join(' ') });
        skipped += 1;
        continue;
      }

      // Idempotence: if ANY existing template already has identical content
      // (whatever its name — including a "… (imported)" copy made by a previous
      // run), the entry adds nothing new. Skip it so repeated imports converge.
      if (existingList.some((template) => this.isSameContent(template, entry))) {
        details.push({ name: entry.name, status: 'skipped', reason: 'An identical template already exists in this project.' });
        skipped += 1;
        continue;
      }

      const key = entry.name.trim().toLowerCase();
      const existing = existingByName.get(key);

      let finalName = entry.name;
      let isConflict = false;
      if (existing) {
        // Same name but different content → keep BOTH by importing a renamed copy.
        finalName = this.uniqueName(entry.name, existingByName);
        isConflict = true;
      }

      try {
        const created = await this.createTemplate(projectId, {
          ...entry,
          name: finalName,
          // Imported templates never steal the default role automatically.
          isDefault: false,
        });
        existingByName.set(finalName.trim().toLowerCase(), created);
        existingList.push(created);
        imported += 1;
        if (isConflict) {
          conflicted += 1;
          details.push({ name: finalName, status: 'conflict', reason: `"${entry.name}" already existed with different content; imported as "${finalName}".` });
        } else {
          details.push({ name: finalName, status: 'imported' });
        }
      } catch (error) {
        skipped += 1;
        details.push({ name: finalName, status: 'skipped', reason: error instanceof Error ? error.message : String(error) });
      }
    }

    return { imported, skipped, conflicted, details };
  }

  /** Whether an existing template matches a bundle entry's content-bearing fields. */
  private isSameContent(existing: PromptTemplate, entry: PromptBundleEntry): boolean {
    return (
      existing.content === entry.content &&
      existing.category === entry.category &&
      (existing.description ?? '') === (entry.description ?? '') &&
      existing.taskKind === entry.taskKind &&
      JSON.stringify(existing.variables) === JSON.stringify(entry.variables)
    );
  }

  /** Derives a unique display name (`"X (imported)"`, `"X (imported 2)"`, …). */
  private uniqueName(base: string, taken: Map<string, PromptTemplate>): string {
    const trimmed = base.trim();
    let candidate = `${trimmed} (imported)`;
    let counter = 2;
    while (taken.has(candidate.trim().toLowerCase())) {
      candidate = `${trimmed} (imported ${counter})`;
      counter += 1;
    }
    return candidate;
  }

  /* ------------------------------ Helpers ------------------------------- */

  /**
   * Verifies that provider/model preferences reference EXISTING local records.
   *
   * This does not resolve the model (R2) and does not touch the task assignment
   * tables; it only prevents storing a dangling pointer. A missing provider → the
   * template simply keeps no preference (the resolver still decides at runtime).
   */
  private async assertPreferencesExist(providerId: string | null, modelId: string | null): Promise<void> {
    if (providerId !== null) {
      const provider = await this.aiRepository.getProvider(providerId);
      if (!provider) {
        throw new PromptTemplateError(`Provider "${providerId}" does not exist; the preference was rejected.`);
      }
    }
    if (modelId !== null) {
      const model = await this.aiRepository.getModel(modelId);
      if (!model) {
        throw new PromptTemplateError(`Model "${modelId}" does not exist; the preference was rejected.`);
      }
      // A model preference must be consistent with its provider preference.
      if (providerId !== null && model.providerId !== providerId) {
        throw new PromptTemplateError('The selected model does not belong to the selected provider.');
      }
    }
  }

  /** Clears the default flag on other templates of the same (project, task). */
  private async clearDefaultForTask(projectId: string, task: AiTaskKind, exceptId: string): Promise<void> {
    const templates = await this.listTemplates(projectId);
    for (const template of templates) {
      if (template.id !== exceptId && template.taskKind === task && template.isDefault) {
        await this.repository.putTemplate({ ...template, isDefault: false, updatedAt: now() });
      }
    }
  }

  /** Builds an immutable version snapshot from a template snapshot. */
  private toVersion(
    template: PromptTemplate,
    versionId: string,
    versionNumber: number,
    reason: PromptTemplateVersion['reason'],
    label?: string,
  ): PromptTemplateVersion {
    return {
      id: versionId,
      templateId: template.id,
      projectId: template.projectId,
      version: versionNumber,
      name: template.name,
      description: template.description,
      category: template.category,
      content: template.content,
      variables: template.variables,
      taskKind: template.taskKind,
      reason,
      label: label ?? '',
      createdAt: now(),
    };
  }

  private toBundleEntry(template: PromptTemplate): PromptBundleEntry {
    return {
      name: template.name,
      description: template.description,
      category: template.category,
      content: template.content,
      variables: template.variables,
      taskKind: template.taskKind,
      enabled: template.enabled,
    };
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof PromptTemplateError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new PromptTemplateError(message, error);
  }
}
