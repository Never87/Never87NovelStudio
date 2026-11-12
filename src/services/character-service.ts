import { ZodError } from 'zod';
import { createCharacterId } from '@/utils/id';
import { now } from '@/utils/date';
import type { Character, CharacterRole, CharacterStatus } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { CharacterRepository } from '@/repositories/character-repository';
import { ProjectServiceError } from './project-service';

/** Fields a caller may set when creating a character. */
export interface CreateCharacterInput {
  name: string;
  summary?: string;
  background?: string;
  personality?: string;
  motivation?: string;
  appearance?: string;
  role?: CharacterRole;
  status?: CharacterStatus;
  tags?: string[];
}

/** Fields a caller may change on an existing character. Every field is optional. */
export interface UpdateCharacterInput {
  name?: string;
  summary?: string;
  background?: string;
  personality?: string;
  motivation?: string;
  appearance?: string;
  role?: CharacterRole;
  status?: CharacterStatus;
  tags?: string[];
}

/**
 * Business layer for characters.
 *
 * Owns ids, timestamps and defaults; it never touches Dexie tables directly.
 */
export class CharacterService {
  private readonly repository: CharacterRepository;

  constructor(repository: CharacterRepository = new CharacterRepository()) {
    this.repository = repository;
  }

  /** Adds a character to `projectId`. */
  async createCharacter(projectId: string, input: CreateCharacterInput): Promise<Character> {
    const timestamp = now();
    const character: Character = {
      id: createCharacterId(),
      projectId,
      name: input.name,
      summary: input.summary ?? '',
      background: input.background ?? '',
      personality: input.personality ?? '',
      motivation: input.motivation ?? '',
      appearance: input.appearance ?? '',
      role: input.role ?? 'supporting',
      status: input.status ?? 'active',
      tags: input.tags ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.repository.create(character);
    } catch (error) {
      throw this.wrap(error, `Failed to create character "${input.name}"`);
    }
  }

  /** Returns the character with `id`, or `null` when it does not exist. */
  async getCharacter(id: string): Promise<Character | null> {
    try {
      return await this.repository.getById(id);
    } catch (error) {
      throw this.wrap(error, `Failed to load character "${id}"`);
    }
  }

  /** All characters of `projectId`, ordered by name. */
  async listCharacters(projectId: string): Promise<Character[]> {
    try {
      return await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list characters of project "${projectId}"`);
    }
  }

  /**
   * Applies a partial update.
   *
   * - Fails when the character does not exist (never creates it).
   * - Never allows `id`, `projectId` or `createdAt` to change.
   * - Leaves omitted fields untouched and refreshes `updatedAt`.
   * - Guards project scoping: a character that belongs to a different project
   *   is treated as not found, so a stale UI can never edit across projects.
   */
  async updateCharacter(
    projectId: string,
    id: string,
    input: UpdateCharacterInput,
  ): Promise<Character> {
    const existing = await this.getCharacter(id);
    if (!existing || existing.projectId !== projectId) {
      throw new ProjectServiceError(
        `Character "${id}" was not found in project "${projectId}"`,
      );
    }

    const merged: Character = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.background !== undefined ? { background: input.background } : {}),
      ...(input.personality !== undefined ? { personality: input.personality } : {}),
      ...(input.motivation !== undefined ? { motivation: input.motivation } : {}),
      ...(input.appearance !== undefined ? { appearance: input.appearance } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      updatedAt: now(),
      // `id`, `projectId` and `createdAt` stay as they were.
    };

    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update character "${id}"`);
    }
  }

  /** Deletes a character, scoped to its project. */
  async deleteCharacter(projectId: string, id: string): Promise<void> {
    const existing = await this.getCharacter(id);
    if (!existing || existing.projectId !== projectId) {
      throw new ProjectServiceError(
        `Character "${id}" was not found in project "${projectId}"`,
      );
    }
    try {
      await this.repository.delete(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete character "${id}"`);
    }
  }

  /** Deletes every character of `projectId` (cascade cleanup). Idempotent. */
  async deleteCharactersOfProject(projectId: string): Promise<number> {
    try {
      return await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete characters of project "${projectId}"`);
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
