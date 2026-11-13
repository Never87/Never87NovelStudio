import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextConfig, ContextItem } from '@/types';
import type {
  CreateContextItemInput,
  UpdateContextItemInput,
  UpdateContextConfigInput,
} from '@/services';
import { contextManagerService } from '@/services';

export type ContextStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseContextManagerResult {
  config: ContextConfig | null;
  items: ContextItem[];
  status: ContextStatus;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  updateConfig: (input: UpdateContextConfigInput) => Promise<ContextConfig>;
  createItem: (input: CreateContextItemInput) => Promise<ContextItem>;
  updateItem: (id: string, input: UpdateContextItemInput) => Promise<ContextItem>;
  deleteItem: (id: string) => Promise<void>;
}

/**
 * Loads and mutates a project's AI Context Manager state (P6).
 *
 * Returns the persisted config (budget + persistent instructions) and the
 * user-controlled items. Content resolution happens in `ContextAssemblyService`,
 * not here — this hook only manages what the user has chosen.
 */
export function useContextManager(projectId: string | null | undefined): UseContextManagerResult {
  const [config, setConfig] = useState<ContextConfig | null>(null);
  const [items, setItems] = useState<ContextItem[]>([]);
  const [status, setStatus] = useState<ContextStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!projectId) {
      setConfig(null);
      setItems([]);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const [nextConfig, nextItems] = await Promise.all([
        contextManagerService.getConfig(projectId),
        contextManagerService.listItems(projectId),
      ]);
      if (!mountedRef.current) return;
      setConfig(nextConfig);
      setItems(nextItems);
      setStatus('success');
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus('error');
      setError(err);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        const result = await operation();
        await load();
        return result;
      } catch (err) {
        if (mountedRef.current) setError(err);
        throw err;
      }
    },
    [load],
  );

  return {
    config,
    items,
    status,
    loading: status === 'loading',
    error,
    refresh: load,
    updateConfig: useCallback(
      (input: UpdateContextConfigInput) => {
        if (!projectId) return Promise.reject(new Error('No project selected.'));
        return mutate(() => contextManagerService.updateConfig(projectId, input));
      },
      [mutate, projectId],
    ),
    createItem: useCallback(
      (input: CreateContextItemInput) => {
        if (!projectId) return Promise.reject(new Error('No project selected.'));
        return mutate(() => contextManagerService.createItem(projectId, input));
      },
      [mutate, projectId],
    ),
    updateItem: useCallback(
      (id: string, input: UpdateContextItemInput) => mutate(() => contextManagerService.updateItem(id, input)),
      [mutate],
    ),
    deleteItem: useCallback(
      (id: string) => mutate(() => contextManagerService.deleteItem(id)).then(() => undefined),
      [mutate],
    ),
  };
}
