import { useCallback, useEffect, useRef, useState } from 'react';
import type { Evidence, KnowledgeEntry, KnowledgeEntryKind } from '@/types';
import type {
  CreateKnowledgeInput,
  ImportKnowledgeResult,
  UpdateKnowledgeInput,
} from '@/services';
import { knowledgeService } from '@/services';

export type KnowledgeStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseKnowledgeBaseResult {
  entries: KnowledgeEntry[];
  status: KnowledgeStatus;
  loading: boolean;
  importing: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  createEntry: (input: CreateKnowledgeInput) => Promise<KnowledgeEntry>;
  updateEntry: (id: string, input: UpdateKnowledgeInput) => Promise<KnowledgeEntry>;
  deleteEntry: (id: string) => Promise<void>;
  /** One-click idempotent index of every supported existing entity. */
  importFromProject: () => Promise<ImportKnowledgeResult>;
}

/**
 * Loads and mutates a project's Knowledge Base (P7).
 *
 * Search is performed client-side over the loaded entries (the project's set is
 * bounded and already in memory), so this hook exposes CRUD + import only; the
 * panel filters `entries` by the query. Mutations reload so ordering stays
 * authoritative in the database.
 */
export function useKnowledgeBase(projectId: string | null | undefined): UseKnowledgeBaseResult {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [status, setStatus] = useState<KnowledgeStatus>('idle');
  const [importing, setImporting] = useState(false);
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
        setEntries([]);
        setStatus('idle');
      }
      return;
    }
    setStatus('loading');
    try {
      const next = await knowledgeService.listEntries(id);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setEntries(next);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setEntries([]);
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
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        const result = await operation();
        await refresh();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [refresh],
  );

  return {
    entries,
    status,
    loading: status === 'loading',
    importing,
    error,
    refresh,
    createEntry: useCallback(
      (input: CreateKnowledgeInput) => mutate(() => knowledgeService.createEntry(requireId('add an entry'), input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    updateEntry: useCallback(
      (id: string, input: UpdateKnowledgeInput) =>
        mutate(() => knowledgeService.updateEntry(requireId('update an entry'), id, input)),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    deleteEntry: useCallback(
      (id: string) => mutate(() => knowledgeService.deleteEntry(requireId('delete an entry'), id)).then(() => undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [mutate, projectId],
    ),
    importFromProject: useCallback(async () => {
      const id = requireId('import knowledge');
      setImporting(true);
      try {
        const result = await knowledgeService.importFromProject(id);
        await refresh();
        return result;
      } finally {
        if (mountedRef.current) setImporting(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [refresh, projectId]),
  };
}

/** Helper type re-export used by the panel's kind filters. */
export type { KnowledgeEntryKind, Evidence };
