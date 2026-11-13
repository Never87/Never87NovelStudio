import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContinuityFact } from '@/types';
import type { CreateContinuityFactInput, SubjectState, UpdateContinuityFactInput } from '@/services';
import { continuityService } from '@/services';

export type ContinuityStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseContinuityResult {
  facts: ContinuityFact[];
  /** Reconstructed state after all facts (latest per subject+predicate). */
  currentState: SubjectState[];
  status: ContinuityStatus;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  /** Reconstructs state "as of" (up to and including) a chapter. */
  stateAsOf: (chapterId: string) => Promise<SubjectState[]>;
  createFact: (input: CreateContinuityFactInput) => Promise<void>;
  updateFact: (id: string, input: UpdateContinuityFactInput) => Promise<void>;
  deleteFact: (id: string) => Promise<void>;
}

/**
 * Loads and mutates a project's continuity facts and derived state (P7).
 *
 * `currentState` is recomputed by the Service on every refresh, always against
 * the LIVE outline order, so chapter reordering never leaves stale state.
 */
export function useContinuity(projectId: string | null | undefined): UseContinuityResult {
  const [facts, setFacts] = useState<ContinuityFact[]>([]);
  const [current, setCurrent] = useState<SubjectState[]>([]);
  const [status, setStatus] = useState<ContinuityStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number, id: string | null | undefined) => {
    if (!id) {
      if (mountedRef.current && token === requestIdRef.current) {
        setFacts([]);
        setCurrent([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const [nextFacts, nextState] = await Promise.all([
        continuityService.listFacts(id),
        continuityService.currentState(id),
      ]);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setFacts(nextFacts);
      setCurrent(nextState);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setFacts([]);
      setCurrent([]);
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

  const requireId = (action: string): string => {
    if (!projectId) throw new Error(`Cannot ${action} without a project id.`);
    return projectId;
  };

  const mutate = useCallback(
    async (operation: () => Promise<unknown>) => {
      try {
        await operation();
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [refresh],
  );

  return {
    facts,
    currentState: current,
    status,
    loading: status === 'loading',
    error,
    refresh,
    stateAsOf: useCallback(
      (chapterId: string) => continuityService.stateAsOf(requireId('reconstruct state'), chapterId),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [projectId],
    ),
    createFact: useCallback(
      (input: CreateContinuityFactInput) => mutate(() => continuityService.createFact(requireId('add a fact'), input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    updateFact: useCallback(
      (id: string, input: UpdateContinuityFactInput) =>
        mutate(() => continuityService.updateFact(requireId('update a fact'), id, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    deleteFact: useCallback(
      (id: string) => mutate(() => continuityService.deleteFact(requireId('delete a fact'), id)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
  };
}
