import { useCallback, useState } from 'react';
import type { AiTaskKind } from '@/types';
import type { AssembledRequest, AssemblyInput, AiProposal } from '@/services';
import { aiAssistanceService, contextAssemblyService } from '@/services';

export interface UsePromptRequestResult {
  /** The most recently assembled request (the preview payload). */
  request: AssembledRequest | null;
  assembling: boolean;
  error: unknown;
  /** Assemble a request for preview WITHOUT sending it. */
  assemble: (input: AssemblyInput) => Promise<AssembledRequest>;
  /**
   * Assemble and EXECUTE via the shared P5 path. The assembled `messages` are
   * passed straight to `AiAssistanceService.run`, so preview == what is sent (R5).
   */
  run: (input: AssemblyInput & { sourceText: string; signal?: AbortSignal }) => Promise<{ request: AssembledRequest; proposal: AiProposal }>;
}

/**
 * Drives request assembly for the Prompt/Context UI (P6).
 *
 * Key guarantee (R5): `run` executes the EXACT messages produced by
 * `contextAssemblyService.assemble` — the same object the preview shows. There is
 * no second prompt-building path.
 */
export function usePromptRequest(): UsePromptRequestResult {
  const [request, setRequest] = useState<AssembledRequest | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const assemble = useCallback(async (input: AssemblyInput) => {
    setAssembling(true);
    setError(null);
    try {
      const assembled = await contextAssemblyService.assemble(input);
      setRequest(assembled);
      return assembled;
    } catch (err) {
      setError(err);
      setRequest(null);
      throw err;
    } finally {
      setAssembling(false);
    }
  }, []);

  const run = useCallback(
    async (input: AssemblyInput & { sourceText: string; signal?: AbortSignal }) => {
      const assembled = await assemble(input);
      const proposal = await aiAssistanceService.run({
        task: input.task as AiTaskKind,
        sourceText: input.sourceText,
        // The assembled messages are authoritative — this is the single pipeline.
        messages: assembled.messages,
        modelId: input.modelId,
        signal: input.signal,
        chapterTitle: typeof input.values?.chapterTitle === 'string' ? input.values.chapterTitle : undefined,
      });
      return { request: assembled, proposal };
    },
    [assemble],
  );

  return { request, assembling, error, assemble, run };
}
