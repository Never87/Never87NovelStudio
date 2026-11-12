import { useCallback, useEffect, useRef, useState } from 'react';
import type { World } from '@/types';
import { worldService, type CreateWorldInput, type UpdateWorldInput } from '@/services';

/** Explicit load state, so "no world yet" is never confused with a failure. */
export type WorldLoadStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface UseWorldResult {
  /** The world, or `null` while loading / absent / failed. */
  world: World | null;
  status: WorldLoadStatus;
  loading: boolean;
  /** True specifically when the project has no world yet. */
  isEmpty: boolean;
  /** The last error object, preserved intact (e.g. `ProjectRepositoryError`). */
  error: unknown;
  refresh: () => Promise<void>;
  createWorld: (input: CreateWorldInput) => Promise<World>;
  updateWorld: (input: UpdateWorldInput) => Promise<World>;
  deleteWorld: () => Promise<void>;
}

/**
 * Loads and mutates the world of one project.
 *
 * - Reloads when `projectId` changes.
 * - Distinguishes "no world yet" (`isEmpty`) from a real failure (`error`).
 * - Race-safe: a response for an old project can never overwrite the current
 *   one, and mutations are ignored after unmount.
 * - Mutations refresh local state with the returned record.
 */
export function useWorld(projectId: string | undefined): UseWorldResult {
  const [world, setWorld] = useState<World | null>(null);
  const [status, setStatus] = useState<WorldLoadStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number, id: string | undefined) => {
    if (!id) {
      if (mountedRef.current && token === requestIdRef.current) {
        setWorld(null);
        setStatus('idle');
        setError(null);
      }
      return;
    }

    setStatus('loading');
    try {
      const result = await worldService.getWorld(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;

      if (result) {
        setWorld(result);
        setStatus('success');
        setError(null);
      } else {
        setWorld(null);
        setStatus('empty');
        setError(null);
      }
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setWorld(null);
      setStatus('error');
      setError(err);
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, projectId);
  }, [load, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createWorld = useCallback(
    async (input: CreateWorldInput): Promise<World> => {
      if (!projectId) throw new Error('Cannot create a world without a project id.');
      try {
        const created = await worldService.createWorld(projectId, input);
        if (mountedRef.current && created.projectId === projectId) {
          setWorld(created);
          setStatus('success');
          setError(null);
        }
        return created;
      } catch (err) {
        if (mountedRef.current) {
          setError(err);
          setStatus('error');
        }
        throw err;
      }
    },
    [projectId],
  );

  const updateWorld = useCallback(
    async (input: UpdateWorldInput): Promise<World> => {
      if (!projectId) throw new Error('Cannot update a world without a project id.');
      try {
        const updated = await worldService.updateWorld(projectId, input);
        if (mountedRef.current && updated.projectId === projectId) {
          setWorld(updated);
          setStatus('success');
          setError(null);
        }
        return updated;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [projectId],
  );

  const deleteWorld = useCallback(async (): Promise<void> => {
    if (!projectId) throw new Error('Cannot delete a world without a project id.');
    try {
      await worldService.deleteWorld(projectId);
      if (mountedRef.current) {
        setWorld(null);
        setStatus('empty');
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(err);
      throw err;
    }
  }, [projectId]);

  return {
    world,
    status,
    loading: status === 'loading',
    isEmpty: status === 'empty',
    error,
    refresh,
    createWorld,
    updateWorld,
    deleteWorld,
  };
}
