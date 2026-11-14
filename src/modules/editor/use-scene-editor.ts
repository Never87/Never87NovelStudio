import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { manuscriptService, sceneService } from '@/services';
import type { Scene } from '@/types';
import {
  AutosaveEngine,
  type AutosaveSnapshot,
  type AutosaveStore,
  type AutosaveTarget,
} from './autosave-engine';

/**
 * Service-backed store for the SCENE autosave engine.
 *
 * Mirrors `use-chapter-editor`'s store, but routes every write through
 * `saveSceneDraft`. The engine itself is storage-agnostic, so the same
 * debounce/serialise/revision contract applies to scene prose unchanged.
 */
const sceneManuscriptStore: AutosaveStore = {
  save(target: AutosaveTarget, input, options) {
    return manuscriptService.saveSceneDraft(target.projectId, target.ownerId, input, options);
  },
};

/** What the scene editor opens: the scene's design record plus its prose. */
export interface SceneEditorDocument {
  scene: Scene;
  /** True when the draft was created on the fly (no prose existed yet). */
  created: boolean;
  content: string;
  wordCount: number;
  /** The revision the autosave engine is currently based on. */
  revision: number;
}

export interface UseSceneEditorResult {
  document: SceneEditorDocument | null;
  status: 'idle' | 'loading' | 'success' | 'not-found' | 'error';
  error: unknown;
  autosave: AutosaveSnapshot;
  onChange: (markdown: string) => void;
  saveNow: () => Promise<void>;
  retry: () => Promise<void>;
  reload: () => Promise<void>;
}

/**
 * Loads a scene's manuscript and drives its autosave.
 *
 * Intentionally a deliberately small, separate hook (rather than a
 * `kind`-parameterised shared hook): the chapter editor also owns version
 * history, sibling navigation and title metadata that a scene editor does not
 * need, and branching those off a single hook would make the chapter lifecycle
 * harder to reason about. Both hooks DO share the one `AutosaveEngine` and the
 * same cleanup discipline (flush-only, never dispose — see the P4 defect in
 * `docs/AI_HANDOFF.md` §7.2/§7.3).
 *
 * Unlike the chapter editor it never binds a `beforeunload` guard: the chapter
 * editor already installs one while the Writing tab is mounted, and two
 * listeners would not add protection. It also does not expose a "create
 * version" entry yet (scene version history is out of scope for this UI), but
 * the underlying versions are still written by the service on manual snapshot.
 */
export function useSceneEditor(
  projectId: string | undefined,
  sceneId: string | undefined,
): UseSceneEditorResult {
  const [document, setDocument] = useState<SceneEditorDocument | null>(null);
  const [status, setStatus] = useState<UseSceneEditorResult['status']>('idle');
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

  /** Flush-on-cleanup; never disposes the engine (see `use-chapter-editor`). */
  const flushOnCleanup = useCallback((reason: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.flush().catch((flushError: unknown) => {
      console.error(
        `[useSceneEditor] Failed to flush the scene manuscript while ${reason}; ` +
          'the latest text may not be persisted.',
        flushError,
      );
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (!engineRef.current) {
    engineRef.current = new AutosaveEngine(sceneManuscriptStore, {
      debounceMs: 800,
      maxWaitMs: 5_000,
      onChange: (snapshot) => {
        if (mountedRef.current) setAutosave(snapshot);
      },
    });
  }

  const load = useCallback(async (pid: string, sid: string) => {
    const token = ++requestRef.current;
    setStatus('loading');
    setError(null);
    try {
      const [scene, draft] = await Promise.all([
        sceneService.getScene(sid),
        manuscriptService.openSceneDraft(pid, sid),
      ]);
      if (!mountedRef.current || token !== requestRef.current) return;
      if (!scene || scene.projectId !== pid) {
        setDocument(null);
        setStatus('not-found');
        return;
      }
      setDocument({
        scene,
        created: false,
        content: draft.content,
        wordCount: draft.wordCount,
        revision: draft.revision,
      });
      setStatus('success');
      engineRef.current?.bind({
        projectId: pid,
        ownerId: sid,
        revision: draft.revision,
        content: draft.content,
      });
    } catch (err) {
      if (!mountedRef.current || token !== requestRef.current) return;
      setDocument(null);
      setError(err);
      const name = err instanceof Error ? err.name : '';
      setStatus(name === 'OutlineNotFoundError' ? 'not-found' : 'error');
    }
  }, []);

  useEffect(() => {
    if (!projectId || !sceneId) {
      setStatus('idle');
      setDocument(null);
      return;
    }
    void load(projectId, sceneId);
    return () => {
      flushOnCleanup('switching scenes');
    };
  }, [projectId, sceneId, load, flushOnCleanup]);

  useEffect(() => {
    return () => {
      flushOnCleanup('unmounting the scene editor');
    };
  }, [flushOnCleanup]);

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
    if (projectId && sceneId) await load(projectId, sceneId);
  }, [projectId, sceneId, load]);

  const createVersion = useCallback(
    async (label = '') => {
      if (!sceneId) return;
      await engineRef.current?.flush();
      await manuscriptService.createManualVersion('scene', sceneId, label);
    },
    [sceneId],
  );

  const restoreVersion = useCallback(
    async (versionId: string) => {
      if (!projectId || !sceneId) return;
      const engine = engineRef.current;
      await engine?.flush();
      const { draft } = await manuscriptService.restoreVersion(versionId);
      engine?.bind({
        projectId,
        ownerId: sceneId,
        revision: draft.revision,
        content: draft.content,
      });
      await load(projectId, sceneId);
    },
    [projectId, sceneId, load],
  );

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
      restoreVersion,
    }),
    [
      document,
      status,
      error,
      autosave,
      onChange,
      saveNow,
      retry,
      reload,
      createVersion,
      restoreVersion,
    ],
  );
}
