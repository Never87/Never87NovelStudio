import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiModel, AiProvider, AiTaskKind } from '@/types';
import type { CreateModelInput, CreateProviderInput, UpdateModelInput, UpdateProviderInput } from '@/services';
import { aiConfigService } from '@/services';

/** Explicit load state, so "nothing configured" is never confused with a failure. */
export type AiConfigStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface UseAiConfigResult {
  providers: AiProvider[];
  models: AiModel[];
  status: AiConfigStatus;
  loading: boolean;
  error: unknown;
  /** Global default model id, or null. */
  globalDefaultModelId: string | null;
  /** Per-task model assignments. */
  taskModels: Record<AiTaskKind, string | null>;
  refresh: () => Promise<void>;
  createProvider: (input: CreateProviderInput) => Promise<AiProvider>;
  updateProvider: (id: string, input: UpdateProviderInput) => Promise<AiProvider>;
  setProviderEnabled: (id: string, enabled: boolean) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  createModel: (input: CreateModelInput) => Promise<AiModel>;
  updateModel: (id: string, input: UpdateModelInput) => Promise<AiModel>;
  setModelEnabled: (id: string, enabled: boolean) => Promise<void>;
  setProviderDefaultModel: (providerId: string, modelId: string) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  setGlobalDefaultModel: (modelId: string | null) => Promise<void>;
  setTaskModel: (task: AiTaskKind, modelId: string | null) => Promise<void>;
}

/**
 * Loads and mutates AI configuration (providers, models, task assignments).
 *
 * Mirrors the other data hooks: state is loaded from the singleton services and
 * every mutation reloads so the database stays authoritative. It never touches
 * Dexie or the network directly.
 */
export function useAiConfig(): UseAiConfigResult {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [globalDefaultModelId, setGlobalDefaultModelId] = useState<string | null>(null);
  const [taskModels, setTaskModels] = useState<Record<AiTaskKind, string | null>>(
    () => ({}) as Record<AiTaskKind, string | null>,
  );
  const [status, setStatus] = useState<AiConfigStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [nextProviders, nextModels, assignments] = await Promise.all([
        aiConfigService.listProviders(),
        aiConfigService.listModels(),
        aiConfigService.getAssignments(),
      ]);
      if (!mountedRef.current) return;
      setProviders(nextProviders);
      setModels(nextModels);
      setGlobalDefaultModelId(assignments.global.defaultModelId);
      setTaskModels(assignments.tasks);
      setStatus(nextProviders.length > 0 || nextModels.length > 0 ? 'success' : 'empty');
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setStatus('error');
      setError(err);
    }
  }, []);

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
    providers,
    models,
    status,
    loading: status === 'loading',
    error,
    globalDefaultModelId,
    taskModels,
    refresh: load,
    createProvider: useCallback((input: CreateProviderInput) => mutate(() => aiConfigService.createProvider(input)), [mutate]),
    updateProvider: useCallback((id: string, input: UpdateProviderInput) => mutate(() => aiConfigService.updateProvider(id, input)), [mutate]),
    setProviderEnabled: useCallback(
      (id: string, enabled: boolean) => mutate(() => aiConfigService.setProviderEnabled(id, enabled)).then(() => undefined),
      [mutate],
    ),
    deleteProvider: useCallback((id: string) => mutate(() => aiConfigService.deleteProvider(id)), [mutate]),
    createModel: useCallback((input: CreateModelInput) => mutate(() => aiConfigService.createModel(input)), [mutate]),
    updateModel: useCallback((id: string, input: UpdateModelInput) => mutate(() => aiConfigService.updateModel(id, input)), [mutate]),
    setModelEnabled: useCallback(
      (id: string, enabled: boolean) => mutate(() => aiConfigService.setModelEnabled(id, enabled)).then(() => undefined),
      [mutate],
    ),
    setProviderDefaultModel: useCallback(
      (providerId: string, modelId: string) =>
        mutate(() => aiConfigService.setProviderDefaultModel(providerId, modelId)),
      [mutate],
    ),
    deleteModel: useCallback((id: string) => mutate(() => aiConfigService.deleteModel(id)), [mutate]),
    setGlobalDefaultModel: useCallback(
      (modelId: string | null) => mutate(() => aiConfigService.setGlobalDefaultModel(modelId)).then(() => undefined),
      [mutate],
    ),
    setTaskModel: useCallback(
      (task: AiTaskKind, modelId: string | null) =>
        mutate(() => aiConfigService.setTaskModel(task, modelId)).then(() => undefined),
      [mutate],
    ),
  };
}
