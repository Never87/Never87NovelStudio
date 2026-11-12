import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Character } from '@/types';
import {
  characterService,
  type CreateCharacterInput,
  type UpdateCharacterInput,
} from '@/services';

export interface UseCharactersResult {
  /** All characters of the project, ordered by name. */
  characters: Character[];
  /** True only until the first load settles (avoids a loading flash on refresh). */
  initialLoading: boolean;
  loading: boolean;
  /** The last error object, preserved intact (e.g. `ProjectRepositoryError`). */
  error: unknown;
  refresh: () => Promise<void>;
  createCharacter: (input: CreateCharacterInput) => Promise<Character>;
  updateCharacter: (id: string, input: UpdateCharacterInput) => Promise<Character>;
  deleteCharacter: (id: string) => Promise<void>;
}

/**
 * Lists and mutates the characters of one project.
 *
 * - Reloads when `projectId` changes.
 * - Race-safe: results for an old project id / after unmount are discarded.
 * - A failed mutation never clears the existing list, so the user keeps their
 *   context and can retry.
 */
export function useCharacters(projectId: string | undefined): UseCharactersResult {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A new project means a fresh list: reset so a previous project's cast is
  // never shown against the new one.
  useEffect(() => {
    hasLoadedRef.current = false;
    setCharacters([]);
    setInitialLoading(true);
    setError(null);
  }, [projectId]);

  const load = useCallback(async (token: number, id: string | undefined) => {
    if (!id) {
      if (mountedRef.current && token === requestIdRef.current) {
        setCharacters([]);
        setInitialLoading(false);
        setLoading(false);
        setError(null);
      }
      return;
    }

    setLoading(true);
    try {
      const result = await characterService.listCharacters(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setCharacters(result);
      setError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setError(err);
    } finally {
      if (mountedRef.current && token === requestIdRef.current) {
        setInitialLoading(false);
        setLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, projectId);
  }, [load, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createCharacter = useCallback(
    async (input: CreateCharacterInput): Promise<Character> => {
      if (!projectId) throw new Error('Cannot create a character without a project id.');
      const created = await characterService.createCharacter(projectId, input);
      await refresh();
      return created;
    },
    [projectId, refresh],
  );

  const updateCharacter = useCallback(
    async (id: string, input: UpdateCharacterInput): Promise<Character> => {
      if (!projectId) throw new Error('Cannot update a character without a project id.');
      const updated = await characterService.updateCharacter(projectId, id, input);
      await refresh();
      return updated;
    },
    [projectId, refresh],
  );

  const deleteCharacter = useCallback(
    async (id: string): Promise<void> => {
      if (!projectId) throw new Error('Cannot delete a character without a project id.');
      await characterService.deleteCharacter(projectId, id);
      await refresh();
    },
    [projectId, refresh],
  );

  // Stable identity while the underlying array is unchanged.
  const value = useMemo<UseCharactersResult>(
    () => ({
      characters,
      initialLoading,
      loading,
      error,
      refresh,
      createCharacter,
      updateCharacter,
      deleteCharacter,
    }),
    [
      characters,
      initialLoading,
      loading,
      error,
      refresh,
      createCharacter,
      updateCharacter,
      deleteCharacter,
    ],
  );

  return value;
}
