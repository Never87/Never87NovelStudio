import { useCallback, useEffect, useRef, useState } from 'react';
import type { Scene } from '@/types';
import type { CreateSceneInput, UpdateSceneInput } from '@/services';
import { sceneService } from '@/services';

export type SceneLoadStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface UseScenesResult {
  scenes: Scene[];
  status: SceneLoadStatus;
  loading: boolean;
  isEmpty: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  createScene: (input: CreateSceneInput) => Promise<Scene>;
  updateScene: (sceneId: string, input: UpdateSceneInput) => Promise<Scene>;
  moveScene: (sceneId: string, direction: -1 | 1) => Promise<void>;
  deleteScene: (sceneId: string) => Promise<void>;
}

/**
 * Loads and mutates the scenes of ONE chapter.
 *
 * Binds `(projectId, chapterId)`; the Service re-verifies that the chapter
 * belongs to the project, so a mismatched pair can never write a scene into the
 * wrong project.
 */
export function useScenes(
  projectId: string | undefined,
  chapterId: string | undefined,
): UseScenesResult {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [status, setStatus] = useState<SceneLoadStatus>('idle');
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
        setScenes([]);
        setStatus('idle');
        setError(null);
      }
      return;
    }
    setStatus('loading');
    try {
      const result = await sceneService.listScenes(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setScenes(result);
      setStatus(result.length > 0 ? 'success' : 'empty');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setScenes([]);
      setStatus('error');
      setError(err);
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, chapterId);
  }, [load, chapterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createScene = useCallback(
    async (input: CreateSceneInput): Promise<Scene> => {
      if (!projectId || !chapterId) {
        throw new Error('Cannot create a scene without a project and chapter id.');
      }
      try {
        const created = await sceneService.createScene(projectId, chapterId, input);
        await refresh();
        return created;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [projectId, chapterId, refresh],
  );

  const updateScene = useCallback(
    async (sceneId: string, input: UpdateSceneInput): Promise<Scene> => {
      try {
        const updated = await sceneService.updateScene(sceneId, input);
        await refresh();
        return updated;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [refresh],
  );

  const moveScene = useCallback(
    async (sceneId: string, direction: -1 | 1) => {
      try {
        await sceneService.moveScene(sceneId, direction);
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [refresh],
  );

  const deleteScene = useCallback(
    async (sceneId: string) => {
      try {
        await sceneService.deleteScene(sceneId);
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [refresh],
  );

  return {
    scenes,
    status,
    loading: status === 'loading',
    isEmpty: status === 'empty',
    error,
    refresh,
    createScene,
    updateScene,
    moveScene,
    deleteScene,
  };
}
