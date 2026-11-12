import { ZodError } from 'zod';
import { createWorldId, createWorldSectionId } from '@/utils/id';
import { now } from '@/utils/date';
import type { World, WorldSection } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { WorldRepository } from '@/repositories/world-repository';
import { ProjectServiceError } from './project-service';

/** Fields a caller may set when creating a world. */
export interface CreateWorldInput {
  title?: string;
  overview?: string;
  sections?: Array<{ title: string; content?: string }>;
  themes?: string[];
  settings?: {
    era?: string;
    technology?: string;
  };
}

/** Fields a caller may change on an existing world. Every field is optional. */
export interface UpdateWorldInput {
  title?: string;
  overview?: string;
  /** Replaces the whole section list (the dialog owns add/remove/reorder). */
  sections?: Array<{ id?: string; title: string; content?: string }>;
  themes?: string[];
  settings?: {
    era?: string | null;
    technology?: string | null;
  };
}

/**
 * Business layer for world records.
 *
 * Owns ids, timestamps, defaults and the "one world per project" rule; it never
 * touches Dexie tables directly. Creation is idempotent-by-check: if the
 * project already has a world, `createWorld` fails instead of silently
 * clobbering it.
 */
export class WorldService {
  private readonly repository: WorldRepository;

  constructor(repository: WorldRepository = new WorldRepository()) {
    this.repository = repository;
  }

  /** The world of `projectId`, or `null` when the project has none yet. */
  async getWorld(projectId: string): Promise<World | null> {
    try {
      return await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to load the world of project "${projectId}"`);
    }
  }

  /** Creates the project's world. Fails if one already exists. */
  async createWorld(projectId: string, input: CreateWorldInput): Promise<World> {
    const existing = await this.getWorld(projectId);
    if (existing) {
      throw new ProjectServiceError(
        `Project "${projectId}" already has a world ("${existing.id}"). Edit it instead.`,
      );
    }

    const timestamp = now();
    const world: World = {
      id: createWorldId(),
      projectId,
      title: input.title ?? 'Untitled world',
      overview: input.overview ?? '',
      sections: (input.sections ?? []).map(toSection),
      themes: input.themes ?? [],
      settings: stripEmptySettings(input.settings),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.repository.create(world);
    } catch (error) {
      throw this.wrap(error, `Failed to create the world of project "${projectId}"`);
    }
  }

  /**
   * Applies a partial update.
   *
   * - Fails when the project has no world (never creates it implicitly).
   * - Never allows `id`, `projectId` or `createdAt` to change.
   * - Omitted fields are left untouched.
   * - `sections` replaces the whole list; a section without an `id` gets one.
   * - `settings` sub-keys set to `null` are removed.
   */
  async updateWorld(projectId: string, input: UpdateWorldInput): Promise<World> {
    const existing = await this.getWorld(projectId);
    if (!existing) {
      throw new ProjectServiceError(
        `Project "${projectId}" has no world to update. Create one first.`,
      );
    }

    const merged: World = {
      ...existing,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.overview !== undefined ? { overview: input.overview } : {}),
      ...(input.themes !== undefined ? { themes: input.themes } : {}),
      ...(input.sections !== undefined
        ? { sections: input.sections.map(toSection) }
        : {}),
      ...(input.settings !== undefined
        ? { settings: mergeWorldSettings(existing.settings, input.settings) }
        : {}),
      updatedAt: now(),
      // `id`, `projectId` and `createdAt` stay as they were.
    };

    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update the world of project "${projectId}"`);
    }
  }

  /** Deletes the project's world, if any. Idempotent. */
  async deleteWorld(projectId: string): Promise<void> {
    try {
      await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete the world of project "${projectId}"`);
    }
  }

  /** Re-throws domain errors unchanged and wraps the rest, keeping the cause. */
  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ProjectServiceError(message, error);
  }
}

/** Normalises a section draft into a stored section (generating an id if needed). */
function toSection(draft: { id?: string; title: string; content?: string }): WorldSection {
  return {
    id: draft.id && draft.id.length > 0 ? draft.id : createWorldSectionId(),
    title: draft.title,
    content: draft.content ?? '',
  };
}

/** Drops empty settings so a create never stores blank strings. */
function stripEmptySettings(
  settings: { era?: string; technology?: string } | undefined,
): World['settings'] {
  const out: { era?: string; technology?: string } = {};
  if (settings?.era && settings.era.trim() !== '') out.era = settings.era;
  if (settings?.technology && settings.technology.trim() !== '') {
    out.technology = settings.technology;
  }
  return out;
}

/**
 * Shallow-merges a settings patch. A key set to `null` or a whitespace-only
 * string is REMOVED; keys absent from the patch are left untouched.
 */
function mergeWorldSettings(
  existing: World['settings'],
  patch: { era?: string | null; technology?: string | null },
): World['settings'] {
  const merged: Record<string, string> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged as World['settings'];
}
