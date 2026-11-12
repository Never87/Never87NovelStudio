import { useCallback, useEffect, useRef, useState } from 'react';
import type { VolumeWithChapters } from '@/services';
import type {
  CreateChapterInput,
  CreateVolumeInput,
  UpdateChapterInput,
  UpdateVolumeInput,
} from '@/services';
import { outlineService, sceneService } from '@/services';

/** Explicit load state, so "no outline yet" is never confused with a failure. */
export type OutlineLoadStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface UseOutlineResult {
  outline: VolumeWithChapters[];
  /** Scene counts keyed by chapter id (for outline badges). */
  sceneCounts: Record<string, number>;
  status: OutlineLoadStatus;
  loading: boolean;
  /** True specifically when the project has no volumes yet. */
  isEmpty: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  createVolume: (input: CreateVolumeInput) => Promise<void>;
  updateVolume: (volumeId: string, input: UpdateVolumeInput) => Promise<void>;
  deleteVolume: (volumeId: string) => Promise<void>;
  createChapter: (volumeId: string, input: CreateChapterInput) => Promise<void>;
  updateChapter: (chapterId: string, input: UpdateChapterInput) => Promise<void>;
  moveChapter: (chapterId: string, direction: -1 | 1) => Promise<void>;
  deleteChapter: (chapterId: string) => Promise<void>;
}

/**
 * Loads and mutates a project's outline (volumes → chapters) plus per-chapter
 * scene counts. Mutations re-read the outline so ordering stays authoritative
 * in the database and never drifts from local state.
 */
export function useOutline(projectId: string | undefined): UseOutlineResult {
  const [outline, setOutline] = useState<VolumeWithChapters[]>([]);
  const [sceneCounts, setSceneCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<OutlineLoadStatus>('idle');
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
        setOutline([]);
        setSceneCounts({});
        setStatus('idle');
        setError(null);
      }
      return;
    }

    setStatus('loading');
    try {
      const [tree, counts] = await Promise.all([
        outlineService.getOutline(id),
        sceneService.countByProject(id),
      ]);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setOutline(tree);
      setSceneCounts(counts);
      setStatus(tree.length > 0 ? 'success' : 'empty');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setOutline([]);
      setSceneCounts({});
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

  /** Runs a mutation, then reloads so ordering/counts come from the DB. */
  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        const result = await operation();
        await refresh();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [refresh],
  );

  const requireId = (action: string): string => {
    if (!projectId) throw new Error(`Cannot ${action} without a project id.`);
    return projectId;
  };

  const createVolume = useCallback(
    async (input: CreateVolumeInput) => {
      const id = requireId('create a volume');
      await mutate(() => outlineService.createVolume(id, input));
    },
    [mutate, projectId],
  );

  const updateVolume = useCallback(
    async (volumeId: string, input: UpdateVolumeInput) => {
      await mutate(() => outlineService.updateVolume(volumeId, input));
    },
    [mutate],
  );

  const deleteVolume = useCallback(
    async (volumeId: string) => {
      await mutate(() => outlineService.deleteVolume(volumeId));
    },
    [mutate],
  );

  const createChapter = useCallback(
    async (volumeId: string, input: CreateChapterInput) => {
      const id = requireId('create a chapter');
      await mutate(() => outlineService.createChapter(id, volumeId, input));
    },
    [mutate, projectId],
  );

  const updateChapter = useCallback(
    async (chapterId: string, input: UpdateChapterInput) => {
      await mutate(() => outlineService.updateChapter(chapterId, input));
    },
    [mutate],
  );

  const moveChapter = useCallback(
    async (chapterId: string, direction: -1 | 1) => {
      await mutate(() => outlineService.moveChapter(chapterId, direction));
    },
    [mutate],
  );

  const deleteChapter = useCallback(
    async (chapterId: string) => {
      await mutate(() => outlineService.deleteChapter(chapterId));
    },
    [mutate],
  );

  return {
    outline,
    sceneCounts,
    status,
    loading: status === 'loading',
    isEmpty: status === 'empty',
    error,
    refresh,
    createVolume,
    updateVolume,
    deleteVolume,
    createChapter,
    updateChapter,
    moveChapter,
    deleteChapter,
  };
}
