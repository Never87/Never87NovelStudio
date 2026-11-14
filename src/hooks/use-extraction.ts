import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractionRecord } from '@/types';
import type {
  CreateManualExtractionInput,
  GenerateAiExtractionsInput,
  GenerateAiExtractionsResult,
} from '@/services';
import { extractionService } from '@/services';

export type ExtractionListStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseExtractionResult {
  /** Every extraction record of the selected document, newest first. */
  records: ExtractionRecord[];
  status: ExtractionListStatus;
  loading: boolean;
  /** True while an extraction mutation (manual create / AI run / delete) is in flight. */
  mutating: boolean;
  error: unknown;

  /** Reloads the selected document's extraction records. */
  refresh: () => Promise<void>;
  /** Creates a review-pending MANUAL candidate (validated + deduped by the service). */
  createManual: (input: CreateManualExtractionInput) => Promise<ExtractionRecord>;
  /** Runs the AI pipeline and returns the created/updated/rejected summary. */
  generateAi: (input: GenerateAiExtractionsInput) => Promise<GenerateAiExtractionsResult>;
  /** Deletes one extraction record (project-scoped). */
  deleteRecord: (extractionId: string) => Promise<void>;
}

/**
 * Information-extraction data hook (P8 Batch 6).
 *
 * The thin React adapter over `extractionService`. Like every other hook it never
 * touches Dexie and never re-implements business rules: gating on confirmed
 * structure, evidence resolution, deduplication and Zod validation all live in
 * the service.
 *
 * The record list is scoped to ONE document (the pipeline's current selected
 * document), which is why the hook takes `documentId`. It is only a VIEW of the
 * document's records — review happens in the Extraction Review Center via
 * `useExtractionReview`.
 */
export function useExtraction(
  projectId: string | null | undefined,
  documentId: string | null | undefined,
): UseExtractionResult {
  const [records, setRecords] = useState<ExtractionRecord[]>([]);
  const [status, setStatus] = useState<ExtractionListStatus>('idle');
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (token: number, pid: string | null | undefined, did: string | null | undefined) => {
      if (!pid || !did) {
        if (mountedRef.current && token === requestIdRef.current) {
          setRecords([]);
          setStatus('idle');
        }
        return;
      }
      setStatus('loading');
      try {
        const next = await extractionService.listExtractionsByDocument(pid, did);
        if (!mountedRef.current || token !== requestIdRef.current) return;
        setRecords(next);
        setStatus('success');
        setError(null);
      } catch (err) {
        if (!mountedRef.current || token !== requestIdRef.current) return;
        setRecords([]);
        setStatus('error');
        setError(err);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, projectId, documentId);
  }, [load, projectId, documentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requireIds = (action: string): { pid: string; did: string } => {
    if (!projectId) throw new Error(`Cannot ${action} without a project id.`);
    if (!documentId) throw new Error(`Cannot ${action} without a document id.`);
    return { pid: projectId, did: documentId };
  };

  /** Runs a mutation with `mutating` state, reloads the list, surfaces errors. */
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
    records,
    status,
    loading: status === 'loading',
    mutating,
    error,
    refresh,
    createManual: useCallback(
      (input: CreateManualExtractionInput) =>
        mutate(() => extractionService.createManualExtraction(requireIds('create an extraction').pid, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, documentId],
    ),
    generateAi: useCallback(
      (input: GenerateAiExtractionsInput) =>
        mutate(() => extractionService.generateAiExtractions(requireIds('run AI extraction').pid, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, documentId],
    ),
    deleteRecord: useCallback(
      (extractionId: string) =>
        mutate(() =>
          extractionService.deleteExtraction(requireIds('delete an extraction').pid, extractionId),
        ).then(() => undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, documentId],
    ),
  };
}
