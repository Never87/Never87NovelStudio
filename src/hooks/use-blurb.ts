/**
 * React binding for the Blurb Generator (P9 Batch D).
 *
 * Owns ONE blurb-generator session for a project:
 *   - runs generation/regeneration through `blurbService` (with cancellation),
 *   - keeps the CURRENT draft text in state so the user can edit it,
 *   - persists ONLY on an explicit `save()` — and only to `NovelProject.blurb`,
 *     never to `description`.
 *
 * The hook never touches Dexie or the network directly; it delegates to the
 * singleton services. Draft text survives re-generations until the user saves or
 * discards, so an unsaved draft is never silently overwritten by a refetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { BlurbServiceError, blurbService, projectService } from '@/services';
import type { BlurbLength, BlurbStyle } from '@/services';
import type { BlurbProposal } from '@/services';
import type { NovelProject } from '@/types';

export type BlurbRunStatus = 'idle' | 'generating' | 'success' | 'error' | 'cancelled';

export interface UseBlurbResult {
  /** The current draft text the user can edit (source of truth for the textarea). */
  draft: string;
  hasDraft: boolean;
  /** True when the draft differs from the saved blurb. */
  dirty: boolean;
  status: BlurbRunStatus;
  generating: boolean;
  error: unknown;
  /** The last proposal's provider/model info (for display). */
  lastProposal: BlurbProposal | null;
  /** The saved blurb on the project (or '' when none). */
  savedBlurb: string;
  /** Whether generation is possible at all (AI configured + project loaded). */
  setDraft: (text: string) => void;
  generate: (options: { length: BlurbLength; style: BlurbStyle; extraInstruction?: string }) => Promise<void>;
  cancel: () => void;
  /** Copies the draft to the clipboard. Resolves to success. */
  copy: () => Promise<boolean>;
  /** Saves the draft to the project's `blurb` field (NOT `description`). */
  save: () => Promise<void>;
  /** Discards the draft back to the saved blurb. */
  discard: () => void;
  /** The loaded project (carries the saved blurb). */
  project: NovelProject | null;
  saving: boolean;
  saveError: unknown;
}

export function useBlurb(projectId: string | null | undefined): UseBlurbResult {
  const [draft, setDraftState] = useState('');
  const [status, setStatus] = useState<BlurbRunStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const [lastProposal, setLastProposal] = useState<BlurbProposal | null>(null);
  const [savedBlurb, setSavedBlurb] = useState('');
  const [project, setProject] = useState<NovelProject | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  // Load the project (for its saved blurb) whenever the project changes.
  useEffect(() => {
    let cancelled = false;
    setStatus('idle');
    setError(null);
    setLastProposal(null);
    setSaveError(null);
    if (!projectId) {
      setProject(null);
      setSavedBlurb('');
      setDraftState('');
      return;
    }
    void (async () => {
      try {
        const loaded = await projectService.getProject(projectId);
        if (cancelled || !mountedRef.current) return;
        setProject(loaded);
        const saved = loaded?.blurb ?? '';
        setSavedBlurb(saved);
        setDraftState(saved);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        setError(err);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const setDraft = useCallback((text: string) => {
    setDraftState(text);
  }, []);

  const generate = useCallback<UseBlurbResult['generate']>(
    async (options) => {
      if (!projectId) {
        setError(new BlurbServiceError('project-not-found', 'Select a project first.'));
        setStatus('error');
        return;
      }
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      generationRef.current += 1;
      const generation = generationRef.current;

      setStatus('generating');
      setError(null);

      try {
        const proposal = await blurbService.generate({
          projectId,
          length: options.length,
          style: options.style,
          ...(options.extraInstruction ? { extraInstruction: options.extraInstruction } : {}),
          signal: controller.signal,
        });
        if (!mountedRef.current || generation !== generationRef.current) return;
        setLastProposal(proposal);
        setDraftState(proposal.generatedText);
        setStatus('success');
      } catch (err) {
        if (!mountedRef.current || generation !== generationRef.current) return;
        // An abort surfaces as a cancelled status, not an error.
        if (controller.signal.aborted) {
          setStatus('cancelled');
          return;
        }
        setError(err);
        setStatus('error');
      }
    },
    [projectId],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus((prev) => (prev === 'generating' ? 'cancelled' : prev));
  }, []);

  const copy = useCallback(async (): Promise<boolean> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(draft);
        return true;
      }
    } catch {
      /* ignore — fall through to legacy path */
    }
    // Legacy fallback for environments without the async clipboard API.
    try {
      if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.value = draft;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
      }
    } catch {
      /* ignore */
    }
    return false;
  }, [draft]);

  const save = useCallback(async () => {
    if (!projectId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await projectService.updateProject(projectId, { blurb: draft });
      if (!mountedRef.current) return;
      setProject(updated);
      setSavedBlurb(updated.blurb ?? '');
    } catch (err) {
      if (mountedRef.current) setSaveError(err);
      throw err;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [projectId, draft]);

  const discard = useCallback(() => {
    setDraftState(savedBlurb);
    setSaveError(null);
  }, [savedBlurb]);

  return {
    draft,
    hasDraft: draft.trim().length > 0,
    dirty: draft !== savedBlurb,
    status,
    generating: status === 'generating',
    error,
    lastProposal,
    savedBlurb,
    setDraft,
    generate,
    cancel,
    copy,
    save,
    discard,
    project,
    saving,
    saveError,
  };
}
