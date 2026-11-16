import { useCallback, useEffect, useRef, useState } from 'react';
import type { WritingGoal } from '@/schemas/writing-goal';
import { writingGoalService } from '@/services';

export interface UseWritingGoalResult {
  /** The active workspace goal, or null when none is set. */
  goal: WritingGoal | null;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  /** Persists a new daily target and refreshes the local goal. */
  setGoal: (dailyWordTarget: number) => Promise<WritingGoal>;
  /** Clears the goal. */
  clearGoal: () => Promise<void>;
}

/**
 * Loads and mutates the workspace-wide writing goal (Round-1 fix).
 *
 * This hook is the shared read/write entry point for the goal so the Dashboard
 * card and the future Writing Goals page observe the SAME persisted value.
 */
export function useWritingGoal(): UseWritingGoalResult {
  const [goal, setGoalState] = useState<WritingGoal | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);

  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number) => {
    setLoading(true);
    try {
      const result = await writingGoalService.getGlobalGoal();
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setGoalState(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setError(err);
    } finally {
      if (mountedRef.current && token === requestIdRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current);
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setGoal = useCallback(async (dailyWordTarget: number): Promise<WritingGoal> => {
    setLoading(true);
    try {
      const saved = await writingGoalService.setGlobalGoal(dailyWordTarget);
      if (mountedRef.current) {
        setGoalState(saved);
        setError(null);
      }
      return saved;
    } catch (err) {
      if (mountedRef.current) setError(err);
      throw err;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const clearGoal = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      await writingGoalService.clearGlobalGoal();
      if (mountedRef.current) {
        setGoalState(null);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) setError(err);
      throw err;
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  return { goal, loading, error, refresh, setGoal, clearGoal };
}
