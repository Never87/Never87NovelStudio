import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChapterAnalysisRun } from '@/types';
import type {
  AnalyzeChapterInput,
  AnalyzeChapterResult,
  UpdateCandidateInput,
  UpdateRelationshipInput,
  IntegrationDecision,
  CandidateIntegrationPreview,
  CandidateIntegrationResult,
  ApplyIntegrationResult,
} from '@/services';
import { chapterAnalysisService, chapterAnalysisIntegrationService } from '@/services';

export type ChapterAnalysisStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseChapterAnalysisResult {
  /** Analysis history for the chapter, newest first (index 0 is the latest). */
  history: ChapterAnalysisRun[];
  /** The latest run (history[0]) or null. */
  latest: ChapterAnalysisRun | null;
  status: ChapterAnalysisStatus;
  loading: boolean;
  /** True while an analysis run is in flight. */
  analyzing: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  /** Runs (or reuses) an analysis pass for the chapter. */
  analyze: (input?: AnalyzeChapterInput) => Promise<AnalyzeChapterResult>;
  updateCandidate: (runId: string, entityKey: string, input: UpdateCandidateInput) => Promise<void>;
  setCandidateStatus: (
    runId: string,
    entityKey: string,
    status: ChapterAnalysisRun['entities'][number]['status'],
  ) => Promise<void>;
  updateRelationship: (runId: string, relationshipKey: string, input: UpdateRelationshipInput) => Promise<void>;
  deleteRun: (runId: string) => Promise<void>;
  /**
   * Preview integration for a run's ACCEPTED candidates (read-only). Returns the
   * alias-aware matches each accepted candidate could resolve to and where a
   * CREATE would land. Never writes.
   */
  previewIntegration: (runId: string) => Promise<CandidateIntegrationPreview[]>;
  /**
   * Applies ONE integration decision (match/create/defer/dismiss/uncertain) to an
   * accepted candidate, then refreshes the history.
   */
  applyIntegration: (runId: string, decision: IntegrationDecision) => Promise<CandidateIntegrationResult>;
  /** Integrates EVERY accepted candidate with the default policy + links relations. */
  integrateAccepted: (runId: string) => Promise<ApplyIntegrationResult>;
  /** Links accepted relationships whose endpoints are both already integrated. */
  linkRelationships: (runId: string) => Promise<ApplyIntegrationResult>;
}

/**
 * Loads and mutates a chapter's analysis runs (P11).
 *
 * Analysis is user-triggered (`analyze`), there is no background scanning. The
 * hook keeps the chapter's re-analysis history newest-first and exposes review
 * actions that update ONE candidate/relationship within a run. All persistence
 * goes through `chapterAnalysisService`; no Dexie access here.
 */
export function useChapterAnalysis(
  projectId: string | null | undefined,
  chapterId: string | null | undefined,
): UseChapterAnalysisResult {
  const [history, setHistory] = useState<ChapterAnalysisRun[]>([]);
  const [status, setStatus] = useState<ChapterAnalysisStatus>('idle');
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number, project: string | null | undefined, chapter: string | null | undefined) => {
    if (!project || !chapter) {
      if (mountedRef.current && token === requestIdRef.current) {
        setHistory([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const next = await chapterAnalysisService.getHistory(project, chapter);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setHistory(next);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setHistory([]);
      setStatus('error');
      setError(err);
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, projectId, chapterId);
  }, [load, projectId, chapterId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requireIds = (action: string): { project: string; chapter: string } => {
    if (!projectId || !chapterId) throw new Error(`Cannot ${action} without a project and chapter id.`);
    return { project: projectId, chapter: chapterId };
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

  const analyze = useCallback(
    async (input: AnalyzeChapterInput = {}): Promise<AnalyzeChapterResult> => {
      const { project, chapter } = requireIds('analyze the chapter');
      setAnalyzing(true);
      setError(null);
      try {
        const result = await chapterAnalysisService.analyzeChapter(project, chapter, input);
        await refresh();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      } finally {
        if (mountedRef.current) setAnalyzing(false);
      }
    },
    [refresh, projectId, chapterId],
  );

  return {
    history,
    latest: history[0] ?? null,
    status,
    loading: status === 'loading',
    analyzing,
    error,
    refresh,
    analyze,
    updateCandidate: useCallback(
      (runId: string, entityKey: string, input: UpdateCandidateInput) =>
        mutate(() => chapterAnalysisService.updateCandidate(requireIds('update a candidate').project, runId, entityKey, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
    setCandidateStatus: useCallback(
      (runId: string, entityKey: string, next: ChapterAnalysisRun['entities'][number]['status']) =>
        mutate(() => chapterAnalysisService.setCandidateStatus(requireIds('update a candidate').project, runId, entityKey, next)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
    updateRelationship: useCallback(
      (runId: string, relationshipKey: string, input: UpdateRelationshipInput) =>
        mutate(() =>
          chapterAnalysisService.updateRelationship(requireIds('update a relationship').project, runId, relationshipKey, input),
        ),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
    deleteRun: useCallback(
      (runId: string) => mutate(() => chapterAnalysisService.deleteRun(requireIds('delete a run').project, runId)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
    previewIntegration: useCallback(
      (runId: string) =>
        chapterAnalysisIntegrationService.previewIntegration(requireIds('preview integration').project, runId),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [projectId, chapterId],
    ),
    applyIntegration: useCallback(
      async (runId: string, decision: IntegrationDecision) => {
        let result: CandidateIntegrationResult | undefined;
        await mutate(async () => {
          result = await chapterAnalysisIntegrationService.applyDecision(
            requireIds('apply an integration').project,
            runId,
            decision,
          );
        });
        return result as CandidateIntegrationResult;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
    integrateAccepted: useCallback(
      async (runId: string) => {
        let result: ApplyIntegrationResult | undefined;
        await mutate(async () => {
          result = await chapterAnalysisIntegrationService.integrateAccepted(requireIds('integrate candidates').project, runId);
        });
        return result as ApplyIntegrationResult;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
    linkRelationships: useCallback(
      async (runId: string) => {
        let result: ApplyIntegrationResult | undefined;
        await mutate(async () => {
          result = await chapterAnalysisIntegrationService.linkRelationships(requireIds('link relationships').project, runId);
        });
        return result as ApplyIntegrationResult;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId, chapterId],
    ),
  };
}
