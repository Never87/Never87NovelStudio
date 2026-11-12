import type { Table } from 'dexie';

import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { CharacterSchema } from '@/schemas/character';
import type { Character } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for characters.
 *
 * Pure persistence only: no id/timestamp generation, no business rules. Writes
 * are validated against `CharacterSchema`, reads are validated back (same
 * strategy as `ProjectRepository`).
 */
export class CharacterRepository {
  private readonly table: Table<Character, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.table = database.characters;
  }

  /** Returns the character with `id`, or `null` when it does not exist. */
  async getById(id: string): Promise<Character | null> {
    let character: Character | undefined;
    try {
      character = await this.table.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read character "${id}"`, error);
    }
    if (character === undefined) return null;
    assertReadableCharacter(character, `Failed to read character "${id}"`);
    return character;
  }

  /** All characters of `projectId`, ordered by name. */
  async getByProjectId(projectId: string): Promise<Character[]> {
    let characters: Character[];
    try {
      characters = await this.table.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to list characters of project "${projectId}"`,
        error,
      );
    }

    characters.forEach((character, index) =>
      assertReadableCharacter(
        character,
        `Failed to list characters of project "${projectId}" (record at position ${index})`,
      ),
    );

    // Sort explicitly so the contract never depends on index/return order.
    return characters.sort(
      (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  /** Inserts a character. Uses `add()` so an existing id is never overwritten. */
  async create(character: Character): Promise<Character> {
    const validated = validateCharacter(character);
    try {
      await this.table.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create character "${character.id}"`, error);
    }
  }

  /** Replaces an existing character. Fails when the id does not exist. */
  async update(character: Character): Promise<Character> {
    const validated = validateCharacter(character);
    try {
      const existing = await this.table.get(validated.id);
      if (!existing) {
        throw new ProjectRepositoryError(`Character "${validated.id}" was not found`);
      }
      await this.table.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update character "${character.id}"`, error);
    }
  }

  /**
   * Deletes a character. Fails when it does not exist (single-record delete is
   * triggered by an explicit user action, so a silent no-op would hide a bug).
   */
  async delete(id: string): Promise<void> {
    try {
      const existing = await this.table.get(id);
      if (!existing) {
        throw new ProjectRepositoryError(`Character "${id}" was not found`);
      }
      await this.table.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete character "${id}"`, error);
    }
  }

  /**
   * Deletes every character of `projectId` (cascade cleanup on project delete).
   *
   * Idempotent: deleting zero records is a success.
   *
   * @returns the number of records removed.
   */
  async deleteByProjectId(projectId: string): Promise<number> {
    try {
      return await this.table.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete characters of project "${projectId}"`,
        error,
      );
    }
  }
}

/** Validates a character before a write, preserving the Zod error as a cause. */
function validateCharacter(character: Character): Character {
  const result = CharacterSchema.safeParse(character);
  if (!result.success) {
    throw new ProjectValidationError(
      `Character "${String(character?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

/** Validates a character READ from the database; never returns malformed data. */
function assertReadableCharacter(character: Character, context: string): void {
  const result = CharacterSchema.safeParse(character);
  if (!result.success) {
    const id = String((character as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}
