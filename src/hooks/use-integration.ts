import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractionRecord } from '@/types';
import type {
  ApplyIntegrationInput,
  ConflictStrategy,
  IntegrationItemResult,
  IntegrationPreview,
} from '@/services';

import { integrationService } from '@/services';

export type IntegrationQueueStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseIntegrationResult {
  /** Confirmed records awaiting integration (not yet applied) for the project. */
  pending: ExtractionRecord[];
  status: IntegrationQueueStatus;
  loading: boolean;
  /** True while an APPLY is in flight (preview is read-only and never sets this). */
  applying: boolean;
  error: unknown;

  /** Reloads the pending-integration list for the current project. */
  refresh: () => Promise<void>;

  /**
   * Builds a READ-ONLY integration preview for a record. Never writes and never
   * applies. Mirrors `IntegrationService.previewIntegration`.
   */
  getPreview: (extractionId: string, fieldStrategies?: Record<string, ConflictStrategy>) => Promise<IntegrationPreview>;

  /**
   * Explicitly applies a previously previewed record. Requires the preview
   * fingerprint; the service re-validates everything inside its transaction and
   * refuses a stale preview. On success the pending list is reloaded so the
   * queue always reflects the database.
   */
  apply: (extractionId: string, input: ApplyIntegrationInput) => Promise<IntegrationItemResult>;
}

/**
 * Project Integration data hook (P8 Batch 5).
 *
 * Mirrors the P2–P8 hook conventions: it never touches Dexie, never re-derives
 * business rules, and always delegates to the singleton `integrationService`.
 * Preview is imperative and READ-ONLY (it cannot mutate the database or the
 * queue); only `apply()` mutates, and it always reloads the pending list on
 * success so the UI is driven by the database, never by optimistic local state.
 *
 * A monotonic request-id guard ensures a slow list load can never overwrite a
 * newer one, and `mountedRef` prevents state writes after unmount.
 */
export function useIntegration(projectId: string | null | undefined): UseIntegrationResult {
  const [pending, setPending] = useState<ExtractionRecord[]>([]);
  const [status, setStatus] = useState<IntegrationQueueStatus>('idle');
  const [applying, setApplying] = useState(false);
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
        setPending([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const next = await integrationService.listPendingIntegration(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setPending(next);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setPending([]);
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

  const getPreview = useCallback(
    (extractionId: string, fieldStrategies?: Record<string, ConflictStrategy>) =>
      integrationService.previewIntegration(requireId('preview'), extractionId, fieldStrategies),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId],
  );

  const apply = useCallback(
    async (extractionId: string, input: ApplyIntegrationInput): Promise<IntegrationItemResult> => {
      setApplying(true);
      try {
        const result = await integrationService.applyIntegration(requireId('apply'), extractionId, input);
        await refresh();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setApplying(false);
      }
    },
    [refresh],
  );

  return {
    pending,
    status,
    loading: status === 'loading',
    applying,
    error,
    refresh,
    getPreview,
    apply,
  };
}
