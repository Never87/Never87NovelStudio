import { useCallback, useEffect, useRef, useState } from 'react';
import type { PromptTemplate, PromptTemplateVersion } from '@/types';
import type {
  CreateTemplateInput,
  UpdateTemplateInput,
  PromptImportResult,
} from '@/services';
import { promptTemplateService } from '@/services';

export type PromptStatus = 'idle' | 'loading' | 'success' | 'empty' | 'error';

export interface UsePromptTemplatesResult {
  templates: PromptTemplate[];
  status: PromptStatus;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  getVersions: (templateId: string) => Promise<PromptTemplateVersion[]>;
  createTemplate: (input: CreateTemplateInput) => Promise<PromptTemplate>;
  updateTemplate: (id: string, input: UpdateTemplateInput) => Promise<PromptTemplate>;
  duplicateTemplate: (id: string, newName?: string) => Promise<PromptTemplate>;
  deleteTemplate: (id: string) => Promise<void>;
  restoreVersion: (id: string, versionId: string) => Promise<PromptTemplate>;
  ensureBuiltins: () => Promise<void>;
  exportBundle: (templateIds?: string[]) => Promise<string>;
  importBundle: (json: string) => Promise<PromptImportResult>;
}

/**
 * Loads and mutates a project's prompt templates (P6).
 *
 * Follows the same pattern as the other data hooks: reads from the singleton
 * service, reloads after every mutation so the database stays authoritative.
 * Never touches Dexie directly.
 */
export function usePromptTemplates(projectId: string | null | undefined): UsePromptTemplatesResult {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [status, setStatus] = useState<PromptStatus>('idle');
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
      setTemplates([]);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    try {
      const next = await promptTemplateService.listTemplates(projectId);
      if (!mountedRef.current) return;
      setTemplates(next);
      setStatus(next.length > 0 ? 'success' : 'empty');
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
    templates,
    status,
    loading: status === 'loading',
    error,
    refresh: load,
    getVersions: useCallback((templateId: string) => promptTemplateService.listVersions(templateId), []),
    createTemplate: useCallback(
      (input: CreateTemplateInput) => {
        if (!projectId) return Promise.reject(new Error('No project selected.'));
        return mutate(() => promptTemplateService.createTemplate(projectId, input));
      },
      [mutate, projectId],
    ),
    updateTemplate: useCallback(
      (id: string, input: UpdateTemplateInput) => mutate(() => promptTemplateService.updateTemplate(id, input)),
      [mutate],
    ),
    duplicateTemplate: useCallback(
      (id: string, newName?: string) => mutate(() => promptTemplateService.duplicateTemplate(id, newName)),
      [mutate],
    ),
    deleteTemplate: useCallback(
      (id: string) => mutate(() => promptTemplateService.deleteTemplate(id)).then(() => undefined),
      [mutate],
    ),
    restoreVersion: useCallback(
      (id: string, versionId: string) => mutate(() => promptTemplateService.restoreVersion(id, versionId)),
      [mutate],
    ),
    ensureBuiltins: useCallback(async () => {
      if (!projectId) return;
      await mutate(() => promptTemplateService.ensureBuiltins(projectId)).then(() => undefined);
    }, [mutate, projectId]),
    exportBundle: useCallback(
      (templateIds?: string[]) => {
        if (!projectId) return Promise.reject(new Error('No project selected.'));
        return promptTemplateService.exportBundle(projectId, templateIds);
      },
      [projectId],
    ),
    importBundle: useCallback(
      (json: string) => {
        if (!projectId) return Promise.reject(new Error('No project selected.'));
        return mutate(() => promptTemplateService.importBundle(projectId, json));
      },
      [mutate, projectId],
    ),
  };
}
