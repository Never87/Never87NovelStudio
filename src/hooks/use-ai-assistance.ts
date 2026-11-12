import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiTaskKind } from '@/types';
import type { AiProposal, InsertAnchor } from '@/services';
import { AiError, aiAssistanceService } from '@/services';

/** The lifecycle of a single assistance request. */
export type AiRunStatus = 'idle' | 'generating' | 'success' | 'error' | 'cancelled';

export interface UseAiAssistanceResult {
  status: AiRunStatus;
  /** The most recent proposal (survives until the next run). */
  proposal: AiProposal | null;
  /** Normalized error for the last failed run, if any. */
  error: AiError | Error | null;
  /** True while a request is in flight. */
  generating: boolean;
  /** Runs a task. Returns the proposal (or null when cancelled/failed). */
  run: (input: {
    task: AiTaskKind;
    sourceText: string;
    chapterTitle?: string;
    instruction?: string;
    modelId?: string;
    /** For continuation tasks: the deterministic insertion position. */
    insertAnchor?: InsertAnchor;
  }) => Promise<AiProposal | null>;
  /** Aborts the in-flight request, if any. */
  cancel: () => void;
  /** Clears the current proposal and error (e.g. after applying/dismissing). */
  reset: () => void;
}

/**
 * Drives AI assistance requests from the UI.
 *
 * Owns the AbortController so a user can cancel a generation, and guarantees a
 * stale response from a cancelled request can never overwrite a newer one
 * (each run carries a generation token). It performs no persistence: applying a
 * proposal is the caller's responsibility, through the editor's update path.
 */
export function useAiAssistance(): UseAiAssistanceResult {
  const [status, setStatus] = useState<AiRunStatus>('idle');
  const [proposal, setProposal] = useState<AiProposal | null>(null);
  const [error, setError] = useState<AiError | Error | null>(null);

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Abort any in-flight request when the consumer unmounts.
      controllerRef.current?.abort();
    };
  }, []);

  const run = useCallback<UseAiAssistanceResult['run']>(async (input) => {
    // Supersede any in-flight run and start a new generation.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;

    setStatus('generating');
    setError(null);

    try {
      const result = await aiAssistanceService.run({ ...input, signal: controller.signal });
      if (!mountedRef.current || generation !== generationRef.current) return null;
      setProposal(result);
      setStatus('success');
      return result;
    } catch (err) {
      if (!mountedRef.current || generation !== generationRef.current) return null;
      if (err instanceof AiError && err.kind === 'aborted') {
        setStatus('cancelled');
        setError(null);
        return null;
      }
      setError(normalizeError(err));
      setStatus('error');
      return null;
    }
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    // The pending run's catch converts this into 'cancelled'; set eagerly so
    // the UI reflects the click immediately.
    setStatus((previous) => (previous === 'generating' ? 'cancelled' : previous));
  }, []);

  const reset = useCallback(() => {
    setProposal(null);
    setError(null);
    setStatus('idle');
  }, []);

  return {
    status,
    proposal,
    error,
    generating: status === 'generating',
    run,
    cancel,
    reset,
  };
}

function normalizeError(err: unknown): AiError | Error {
  if (err instanceof AiError) return err;
  if (err instanceof Error) return err;
  return new Error(String(err));
}
