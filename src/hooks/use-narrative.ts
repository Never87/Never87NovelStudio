import { useCallback, useEffect, useRef, useState } from 'react';
import type { NarrativePlan } from '@/types';
import {
  narrativeService,
  type CreateNarrativeInput,
  type UpdateNarrativeInput,
} from '@/services';

/** Explicit load state, so "no plan yet" is never confused with a failure. */
export type NarrativeLoadStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface UseNarrativeResult {
  /** The plan, or `null` while loading / absent / failed. */
  plan: NarrativePlan | null;
  status: NarrativeLoadStatus;
  loading: boolean;
  /** True specifically when the project has no narrative plan yet. */
  isEmpty: boolean;
  /** The last error object, preserved intact (e.g. `ProjectRepositoryError`). */
  error: unknown;
  refresh: () => Promise<void>;
  createPlan: (input?: CreateNarrativeInput) => Promise<NarrativePlan>;
  updatePlan: (input: UpdateNarrativeInput) => Promise<NarrativePlan>;
  deletePlan: () => Promise<void>;
}

/**
 * Loads and mutates the narrative plan of one project.
 *
 * - Reloads when `projectId` changes.
 * - Distinguishes "no plan yet" (`isEmpty`) from a real failure (`error`).
 * - Race-safe: a response for an old project can never overwrite the current
 *   one, and mutations are ignored after unmount.
 * - Mutations refresh local state with the returned record.
 */
export function useNarrative(projectId: string | undefined): UseNarrativeResult {
  const [plan, setPlan] = useState<NarrativePlan | null>(null);
  const [status, setStatus] = useState<NarrativeLoadStatus>('idle');
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
        setPlan(null);
        setStatus('idle');
        setError(null);
      }
      return;
    }

    setStatus('loading');
    try {
      const result = await narrativeService.getPlan(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;

      if (result) {
        setPlan(result);
        setStatus('success');
        setError(null);
      } else {
        setPlan(null);
        setStatus('empty');
        setError(null);
      }
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setPlan(null);
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

  const createPlan = useCallback(
    async (input: CreateNarrativeInput = {}): Promise<NarrativePlan> => {
      if (!projectId) throw new Error('Cannot create a narrative plan without a project id.');
      try {
        const created = await narrativeService.createPlan(projectId, input);
        if (mountedRef.current && created.projectId === projectId) {
          setPlan(created);
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

  const updatePlan = useCallback(
    async (input: UpdateNarrativeInput): Promise<NarrativePlan> => {
      if (!projectId) throw new Error('Cannot update a narrative plan without a project id.');
      try {
        const updated = await narrativeService.updatePlan(projectId, input);
        if (mountedRef.current && updated.projectId === projectId) {
          setPlan(updated);
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

  const deletePlan = useCallback(async (): Promise<void> => {
    if (!projectId) throw new Error('Cannot delete a narrative plan without a project id.');
    try {
      await narrativeService.deletePlan(projectId);
      if (mountedRef.current) {
        setPlan(null);
        setStatus('empty');
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(err);
      throw err;
    }
  }, [projectId]);

  return {
    plan,
    status,
    loading: status === 'loading',
    isEmpty: status === 'empty',
    error,
    refresh,
    createPlan,
    updatePlan,
    deletePlan,
  };
}
