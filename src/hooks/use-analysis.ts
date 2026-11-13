import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnalysisFinding } from '@/types';
import type { FindingDraft, RunAnalysisResult, UpdateFindingInput } from '@/services';
import { analysisService } from '@/services';

export type AnalysisStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseAnalysisResult {
  findings: AnalysisFinding[];
  status: AnalysisStatus;
  loading: boolean;
  /** True while a deterministic analysis run is in flight. */
  running: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  /** Runs the deterministic detectors and persists evidence-backed findings. */
  runAnalysis: () => Promise<RunAnalysisResult>;
  /** Saves a finding draft (e.g. a user-accepted AI proposal) — requires evidence. */
  saveFinding: (draft: FindingDraft) => Promise<AnalysisFinding>;
  updateFinding: (id: string, input: UpdateFindingInput) => Promise<void>;
  deleteFinding: (id: string) => Promise<void>;
}

/**
 * Loads and mutates a project's analysis findings (P7).
 *
 * Analysis is user-triggered (`runAnalysis`); there is no background scanning.
 * A run only ever creates evidence-backed findings through the Service.
 */
export function useAnalysis(projectId: string | null | undefined): UseAnalysisResult {
  const [findings, setFindings] = useState<AnalysisFinding[]>([]);
  const [status, setStatus] = useState<AnalysisStatus>('idle');
  const [running, setRunning] = useState(false);
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
        setFindings([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const next = await analysisService.listFindings(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setFindings(next);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setFindings([]);
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
    findings,
    status,
    loading: status === 'loading',
    running,
    error,
    refresh,
    runAnalysis: useCallback(async () => {
      const id = requireId('run analysis');
      setRunning(true);
      try {
        const result = await analysisService.runDeterministic(id);
        await refresh();
        return result;
      } finally {
        if (mountedRef.current) setRunning(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh, projectId]),
    saveFinding: useCallback(
      (draft: FindingDraft) => analysisService.saveDraft(requireId('save a finding'), draft).then(async (finding) => {
        await refresh();
        return finding;
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [refresh, projectId],
    ),
    updateFinding: useCallback(
      (id: string, input: UpdateFindingInput) =>
        mutate(() => analysisService.updateFinding(requireId('update a finding'), id, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    deleteFinding: useCallback(
      (id: string) => mutate(() => analysisService.deleteFinding(requireId('delete a finding'), id)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
  };
}
