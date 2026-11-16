import { useCallback, useEffect, useRef, useState } from 'react';
import { writingStatsService, type DashboardStats } from '@/services';

export interface UseDashboardStatsResult {
  stats: DashboardStats | null;
  /** True while a fetch is in flight. */
  loading: boolean;
  /** True only for the very first load, before any data has arrived. */
  initialLoading: boolean;
  /** The last error, kept as-is so callers can inspect its type. */
  error: unknown;
  refresh: () => Promise<void>;
}

/**
 * Loads the real Dashboard statistics (Round-1 fix).
 *
 * - Fetches on mount and on `refresh()`.
 * - Race-safe: an out-of-order response can never overwrite a newer result.
 * - A failed refetch never clears previously loaded `stats`; only `error` is set.
 */
export function useDashboardStats(): UseDashboardStatsResult {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchStats = useCallback(async (token: number) => {
    setLoading(true);
    try {
      const result = await writingStatsService.getDashboardStats();
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setStats(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setError(err);
    } finally {
      if (mountedRef.current && token === requestIdRef.current) {
        setLoading(false);
        setInitialLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await fetchStats(requestIdRef.current);
  }, [fetchStats]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stats, loading, initialLoading, error, refresh };
}
