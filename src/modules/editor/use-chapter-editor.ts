import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  manuscriptService,
  type ChapterEditorDocument,
} from '@/services';
import {
  AutosaveEngine,
  type AutosaveSnapshot,
  type AutosaveStore,
  type AutosaveTarget,
} from './autosave-engine';

/**
 * Service-backed store for the autosave engine.
 *
 * Keeps the engine free of Service imports so it stays unit-testable, while
 * making the production wiring a single object. The target carries both ids, so
 * a write is always scoped to the project the editor was opened for.
 */
const manuscriptStore: AutosaveStore = {
  save(target: AutosaveTarget, input, options) {
    return manuscriptService.saveChapterDraft(target.projectId, target.ownerId, input, options);
  },
};

export interface UseChapterEditorResult {
  document: ChapterEditorDocument | null;
  status: 'idle' | 'loading' | 'success' | 'not-found' | 'error';
  error: unknown;
  /** Live autosave state (drives the status pill). */
  autosave: AutosaveSnapshot;
  /** Called by the editor on every change. */
  onChange: (markdown: string) => void;
  /** Force an immediate save (Ctrl+S / blur). */
  saveNow: () => Promise<void>;
  /** Re-send after a failure. */
  retry: () => Promise<void>;
  /** Reload from the database, discarding local state. */
  reload: () => Promise<void>;
  /** Manual snapshot of the current content. */
  createVersion: (label?: string) => Promise<void>;
}

/**
 * Loads a chapter manuscript and drives its autosave.
 *
 * Concurrency contract with the editor:
 *   - `onChange` only records text into the engine (debounced, serialised).
 *   - Every save is revision-checked, so a stale request can never overwrite
 *     newer prose even when two saves overlap.
 *   - Navigating to another chapter flushes the outgoing document first.
 */
export function useChapterEditor(
  projectId: string | undefined,
  chapterId: string | undefined,
): UseChapterEditorResult {
  const [document, setDocument] = useState<ChapterEditorDocument | null>(null);
  const [status, setStatus] = useState<UseChapterEditorResult['status']>('idle');
  const [error, setError] = useState<unknown>(null);
  const [autosave, setAutosave] = useState<AutosaveSnapshot>({
    status: 'idle',
    lastSavedAt: null,
    error: null,
    conflicts: 0,
    revision: 0,
    dirty: false,
  });

  const engineRef = useRef<AutosaveEngine | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One engine for the lifetime of the hook; the target changes underneath it.
  if (!engineRef.current) {
    engineRef.current = new AutosaveEngine(manuscriptStore, {
      debounceMs: 800,
      maxWaitMs: 5_000,
      onChange: (snapshot) => {
        if (mountedRef.current) setAutosave(snapshot);
      },
    });
  }

  const load = useCallback(
    async (pid: string, cid: string) => {
      const token = ++requestRef.current;
      setStatus('loading');
      setError(null);
      try {
        const loaded = await manuscriptService.openChapterDraft(pid, cid);
        if (!mountedRef.current || token !== requestRef.current) return;
        setDocument(loaded);
        setStatus('success');
        engineRef.current?.bind({
          projectId: pid,
          ownerId: cid,
          revision: loaded.draft.revision,
          content: loaded.draft.content,
        });
      } catch (err) {
        if (!mountedRef.current || token !== requestRef.current) return;
        setDocument(null);
        setError(err);
        const name = err instanceof Error ? err.name : '';
        setStatus(name === 'OutlineNotFoundError' ? 'not-found' : 'error');
      }
    },
    [],
  );

  useEffect(() => {
    const engine = engineRef.current;
    if (!projectId || !chapterId) {
      setStatus('idle');
      setDocument(null);
      return;
    }
    void load(projectId, chapterId);

    return () => {
      // Flush the outgoing chapter when the route changes or the hook unmounts.
      void engine?.flush();
    };
  }, [projectId, chapterId, load]);

  useEffect(() => {
    const engine = engineRef.current;
    return () => {
      // Never leave an orphaned engine writing after unmount.
      void engine?.flush().finally(() => engine?.dispose());
    };
  }, []);

  const onChange = useCallback((markdown: string) => {
    engineRef.current?.update(markdown);
  }, []);

  const saveNow = useCallback(async () => {
    await engineRef.current?.flush();
  }, []);

  const retry = useCallback(async () => {
    await engineRef.current?.retry();
  }, []);

  const reload = useCallback(async () => {
    if (projectId && chapterId) await load(projectId, chapterId);
  }, [projectId, chapterId, load]);

  const createVersion = useCallback(
    async (label = '') => {
      if (!chapterId) return;
      await engineRef.current?.flush();
      await manuscriptService.createManualVersion('chapter', chapterId, label);
    },
    [chapterId],
  );

  // Warn before leaving with unsaved text (browser-level back/refresh guard).
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (engineRef.current?.hasUnsavedChanges) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return useMemo(
    () => ({
      document,
      status,
      error,
      autosave,
      onChange,
      saveNow,
      retry,
      reload,
      createVersion,
    }),
    [document, status, error, autosave, onChange, saveNow, retry, reload, createVersion],
  );
}
