import { useCallback, useEffect, useRef, useState } from 'react';
import type { NovelProject } from '@/types';
import {
  projectService,
  ProjectNotFoundError,
  type UpdateProjectInput,
} from '@/services';

/** Explicit load state, so "not found" is never confused with "database error". */
export type ProjectLoadStatus = 'idle' | 'loading' | 'success' | 'not-found' | 'error';

export interface UseProjectResult {
  /** The loaded project, or `null` while loading / missing / failed. */
  project: NovelProject | null;
  status: ProjectLoadStatus;
  loading: boolean;
  /** True specifically when the project does not exist. */
  notFound: boolean;
  /** The last error object, preserved intact (e.g. `ProjectRepositoryError`). */
  error: unknown;
  refresh: () => Promise<void>;
  updateProject: (input: UpdateProjectInput) => Promise<NovelProject>;
  deleteProject: () => Promise<void>;
}

/**
 * Loads and mutates a single project by id.
 *
 * - Reloads when `projectId` changes.
 * - Distinguishes a missing project (`notFound`) from a real failure (`error`).
 * - Race-safe: a response for an old id can never overwrite the current one.
 * - `updateProject` refreshes local state with the returned project.
 * - `deleteProject` resolves on success (the caller decides where to navigate);
 *   it rejects with the preserved error on failure.
 */
export function useProject(projectId: string | undefined): UseProjectResult {
  const [project, setProject] = useState<NovelProject | null>(null);
  const [status, setStatus] = useState<ProjectLoadStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadById = useCallback(async (token: number, id: string | undefined) => {
    if (!id) {
      // No id to load — reset to a neutral state rather than an error.
      if (mountedRef.current && token === requestIdRef.current) {
        setProject(null);
        setStatus('idle');
        setError(null);
      }
      return;
    }

    setStatus('loading');
    try {
      const result = await projectService.getProject(id);

      // Guard against responses for a stale id / unmounted component.
      if (!mountedRef.current || token !== requestIdRef.current) return;

      if (result) {
        setProject(result);
        setStatus('success');
        setError(null);
      } else {
        setProject(null);
        setStatus('not-found');
        setError(null);
      }
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;

      if (err instanceof ProjectNotFoundError) {
        setProject(null);
        setStatus('not-found');
        setError(null);
      } else {
        // Keep the previous project out of the way, but record the real error.
        setProject(null);
        setStatus('error');
        setError(err);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await loadById(requestIdRef.current, projectId);
  }, [loadById, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateProject = useCallback(
    async (input: UpdateProjectInput): Promise<NovelProject> => {
      if (!projectId) {
        throw new ProjectNotFoundError('<undefined>');
      }
      try {
        const updated = await projectService.updateProject(projectId, input);
        if (mountedRef.current && updated.id === projectId) {
          setProject(updated);
          setStatus('success');
          setError(null);
        }
        return updated;
      } catch (err) {
        if (mountedRef.current) {
          setError(err);
          if (err instanceof ProjectNotFoundError) setStatus('not-found');
        }
        throw err;
      }
    },
    [projectId],
  );

  const deleteProject = useCallback(async (): Promise<void> => {
    if (!projectId) {
      throw new ProjectNotFoundError('<undefined>');
    }
    try {
      await projectService.deleteProject(projectId);
      if (mountedRef.current) {
        setProject(null);
        setStatus('idle');
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(err);
      throw err;
    }
  }, [projectId]);

  return {
    project,
    status,
    loading: status === 'loading',
    notFound: status === 'not-found',
    error,
    refresh,
    updateProject,
    deleteProject,
  };
}
