import { useCallback, useEffect, useRef, useState } from 'react';
import type { NovelProject, ProjectStatus } from '@/types';
import {
  projectService,
  type CreateProjectInput,
  type UpdateProjectInput,
} from '@/services';

export interface UseProjectsOptions {
  /** When set, only projects with this status are listed. */
  status?: ProjectStatus;
}

export interface UseProjectsResult {
  /** Current projects. Preserved across failed refetches (never cleared on error). */
  projects: NovelProject[];
  /** True while a fetch or mutation is in flight. */
  loading: boolean;
  /** True only for the very first load, before any data has arrived. */
  initialLoading: boolean;
  /** The last error, kept as-is (never stringified) so callers can inspect its type. */
  error: unknown;
  refresh: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<NovelProject>;
  updateProject: (id: string, input: UpdateProjectInput) => Promise<NovelProject>;
  deleteProject: (id: string) => Promise<void>;
}

/**
 * Loads and mutates the project list.
 *
 * - Loads on mount and whenever `options.status` changes.
 * - Keeps the Service's ordering — no re-sorting here.
 * - Mutations refresh the list on success.
 * - A failed request never clears existing `projects`; only `error` is set.
 * - Race-safe: an out-of-order response (slow older request or a status that
 *   was switched away from) can never overwrite a newer result.
 */
export function useProjects(options: UseProjectsOptions = {}): UseProjectsResult {
  const { status } = options;

  const [projects, setProjects] = useState<NovelProject[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);

  // Monotonic request token: only the response whose id matches the latest
  // issued request is allowed to commit state.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchProjects = useCallback(
    async (token: number) => {
      setLoading(true);
      try {
        const result = status
          ? await projectService.listProjectsByStatus(status)
          : await projectService.listProjects();

        if (!mountedRef.current || token !== requestIdRef.current) return;

        setProjects(result);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || token !== requestIdRef.current) return;

        // Keep previously loaded projects — a failure must not look like "none".
        setError(err);
      } finally {
        if (mountedRef.current && token === requestIdRef.current) {
          setLoading(false);
          setInitialLoading(false);
        }
      }
    },
    [status],
  );

  /** Issues a new fetch, invalidating any request still in flight. */
  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await fetchProjects(requestIdRef.current);
  }, [fetchProjects]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<NovelProject> => {
      setLoading(true);
      try {
        const created = await projectService.createProject(input);
        await refresh();
        return created;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [refresh],
  );

  const updateProject = useCallback(
    async (id: string, input: UpdateProjectInput): Promise<NovelProject> => {
      setLoading(true);
      try {
        const updated = await projectService.updateProject(id, input);
        await refresh();
        return updated;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [refresh],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<void> => {
      setLoading(true);
      try {
        await projectService.deleteProject(id);
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [refresh],
  );

  return {
    projects,
    loading,
    initialLoading,
    error,
    refresh,
    createProject,
    updateProject,
    deleteProject,
  };
}
