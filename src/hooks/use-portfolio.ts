/**
 * React binding for the Portfolio service (P9 Batch E).
 *
 * Loads the author's catalog as resolved `PortfolioEntry` objects and exposes
 * profile upsert/delete + refresh. It never touches Dexie or re-implements the
 * override/fallback rules — those live in the pure entry module and the service.
 *
 * Race-safe (a stale load can never overwrite a newer one) and preserves the
 * previous list on a failed refetch (a failure must not look like "empty").
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PortfolioEntry, PortfolioProfile, UpdatePortfolioProfileInput } from '@/schemas/portfolio-profile';
import { portfolioService } from '@/services';

export interface UsePortfolioResult {
  /** Resolved, ordered portfolio entries. Preserved across failed refetches. */
  entries: PortfolioEntry[];
  /** True during the first load. */
  initialLoading: boolean;
  /** True during any load or mutation. */
  busy: boolean;
  /** The last error (never stringified). */
  error: unknown;
  refresh: () => Promise<void>;
  /** The raw profile of a project, or null. */
  getProfile: (projectId: string) => Promise<PortfolioProfile | null>;
  /** Creates/updates a project's display profile (never touches description/blurb). */
  saveProfile: (projectId: string, input: UpdatePortfolioProfileInput) => Promise<PortfolioProfile>;
  /** Removes a project's display profile (reverts to project values). */
  deleteProfile: (projectId: string) => Promise<void>;
}

export function usePortfolio(): UsePortfolioResult {
  const [entries, setEntries] = useState<PortfolioEntry[]>([]);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
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
    setBusy(true);
    try {
      const result = await portfolioService.listEntries();
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setEntries(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      // Keep previous entries — a failure must not look like "nothing".
      setError(err);
    } finally {
      if (mountedRef.current && token === requestIdRef.current) {
        setBusy(false);
        setInitialLoading(false);
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current);
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const getProfile = useCallback((projectId: string) => portfolioService.getProfile(projectId), []);

  const saveProfile = useCallback(
    async (projectId: string, input: UpdatePortfolioProfileInput): Promise<PortfolioProfile> => {
      setBusy(true);
      try {
        const saved = await portfolioService.upsertProfile(projectId, input);
        await refresh();
        return saved;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [refresh],
  );

  const deleteProfile = useCallback(
    async (projectId: string): Promise<void> => {
      setBusy(true);
      try {
        await portfolioService.deleteProfile(projectId);
        await refresh();
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    },
    [refresh],
  );

  return { entries, initialLoading, busy, error, refresh, getProfile, saveProfile, deleteProfile };
}
