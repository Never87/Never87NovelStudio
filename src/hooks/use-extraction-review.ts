import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractionRecord, SourceDocument } from '@/types';
import type {
  MergeResult,
  ReviewActionResult,
  ReviewDetail,
  ReviewQueueFilters,
  ReviewQueueItem,
  UpdatePendingInput,
} from '@/services';

import { importService, reviewService } from '@/services';

export type ReviewQueueStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseExtractionReviewResult {
  /** The current review queue (pending-only by default). */
  queue: ReviewQueueItem[];
  status: ReviewQueueStatus;
  loading: boolean;
  /** True while a mutating operation (confirm/reject/merge/edit/restore) is in flight. */
  mutating: boolean;
  error: unknown;

  /** Reloads the queue with the given filters (defaults to the last-used filters). */
  refresh: (filters?: ReviewQueueFilters) => Promise<void>;

  /** Loads one record's full detail payload (record + evidence validity). */
  getDetail: (extractionId: string) => Promise<ReviewDetail>;
  /** Lists the records eligible as merge targets (pending/confirmed, not merged). */
  getMergeCandidates: (excludeId: string) => Promise<ExtractionRecord[]>;
  /** Lists the project's source documents (for filter pickers). */
  listDocuments: () => Promise<SourceDocument[]>;

  /** Confirms a pending record (idempotent). */
  confirm: (extractionId: string) => Promise<ReviewActionResult>;
  /** Rejects a pending record (idempotent). */
  reject: (extractionId: string) => Promise<ReviewActionResult>;
  /** Restores a rejected record to pending (idempotent). */
  restore: (extractionId: string) => Promise<ReviewActionResult>;
  /** Merges a source pending record into a target record (idempotent). */
  merge: (sourceId: string, targetId: string) => Promise<MergeResult>;
  /** Edits a pending record's fields (optionally replacing its evidence). */
  updatePending: (extractionId: string, input: UpdatePendingInput) => Promise<ExtractionRecord>;
}

/**
 * Extraction Review Center data hook (P8 Batch 4).
 *
 * Mirrors the P2–P8 hook conventions: it never touches Dexie, never re-derives
 * business rules, and always delegates to the singleton `reviewService`. A
 * monotonic request-id guard ensures a slow queue load can never overwrite a
 * newer one, and `mountedRef` prevents state writes after unmount.
 *
 * Detail reads are imperative (`getDetail()`) because the reviewer opens one
 * record at a time; only the QUEUE is kept in reactive state. Every mutation
 * reloads the queue on success so the list stays authoritative in the database.
 * Mutating actions never optimistically mutate local state — a record's review
 * status is decided solely by the service (and the DB).
 */
export function useExtractionReview(
  projectId: string | null | undefined,
): UseExtractionReviewResult {
  const [queue, setQueue] = useState<ReviewQueueItem[]>([]);
  const [status, setStatus] = useState<ReviewQueueStatus>('idle');
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const filtersRef = useRef<ReviewQueueFilters>({});

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number, id: string | null | undefined, filters: ReviewQueueFilters) => {
    if (!id) {
      if (mountedRef.current && token === requestIdRef.current) {
        setQueue([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const next = await reviewService.getReviewQueue(id, filters);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setQueue(next);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setQueue([]);
      setStatus('error');
      setError(err);
    }
  }, []);

  const refresh = useCallback(
    async (filters?: ReviewQueueFilters) => {
      if (filters !== undefined) filtersRef.current = filters;
      requestIdRef.current += 1;
      await load(requestIdRef.current, projectId, filtersRef.current);
    },
    [load, projectId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requireId = (action: string): string => {
    if (!projectId) throw new Error(`Cannot ${action} without a project id.`);
    return projectId;
  };

  /** Runs a mutation with `mutating` state, reloads the queue, surfaces errors. */
  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      setMutating(true);
      try {
        const result = await operation();
        await refresh();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setMutating(false);
      }
    },
    [refresh],
  );

  return {
    queue,
    status,
    loading: status === 'loading',
    mutating,
    error,
    refresh,
    getDetail: useCallback(
      (extractionId: string) => reviewService.getReviewDetail(requireId('load reviewer detail'), extractionId),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [projectId],
    ),
    getMergeCandidates: useCallback(
      (excludeId: string) => reviewService.listMergeCandidates(requireId('list merge candidates'), excludeId),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [projectId],
    ),
    listDocuments: useCallback(
      () => importService.listDocuments(requireId('list documents')),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [projectId],
    ),
    confirm: useCallback(
      (extractionId: string) => mutate(() => reviewService.confirmExtraction(requireId('confirm'), extractionId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    reject: useCallback(
      (extractionId: string) => mutate(() => reviewService.rejectExtraction(requireId('reject'), extractionId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    restore: useCallback(
      (extractionId: string) =>
        mutate(() => reviewService.restoreRejectedExtraction(requireId('restore'), extractionId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    merge: useCallback(
      (sourceId: string, targetId: string) =>
        mutate(() => reviewService.mergeExtractions(requireId('merge'), sourceId, targetId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    updatePending: useCallback(
      (extractionId: string, input: UpdatePendingInput) =>
        mutate(() => reviewService.updatePendingExtraction(requireId('edit'), extractionId, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
  };
}
