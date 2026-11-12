import type { AiGenerationResult, AiMessage, AiTaskKind } from '@/types';
import type { AiService, ResolvedAiTarget } from './ai-service';
import type { TaskPromptDefinition, TaskPromptInput } from './ai/task-prompts';
import { TASK_PROMPTS } from './ai/task-prompts';

/**
 * A snapshot of where a continuation should be inserted.
 *
 * Captured when generation begins so Apply inserts at the position the user
 * was looking at when they generated — not wherever the cursor happens to be
 * later. The `contextBefore` string lets Apply verify the document has not
 * changed around the anchor; if it has, the apply is refused rather than
 * silently inserting at a stale offset.
 */
export interface InsertAnchor {
  /** Document position (TipTap `pos`) the continuation was generated from. */
  pos: number;
  /** Document size when captured; a mismatch means the doc changed. */
  docSize: number;
  /** Up to `ANCHOR_CONTEXT_CHARS` characters immediately before `pos`. */
  contextBefore: string;
}

/** How much preceding context is stored to validate an insert anchor. */
export const ANCHOR_CONTEXT_CHARS = 32;

/**
 * A generated suggestion awaiting the user's decision.
 *
 * This is the object the preview UI renders and the apply step consumes. It is
 * NEVER written to the manuscript directly — the user must confirm first.
 */
export interface AiProposal {
  task: AiTaskKind;
  /** How this proposal would be applied. */
  mode: TaskPromptDefinition['mode'];
  /** The text the task operated on (selection or full chapter). */
  originalText: string;
  /** The model's generated text. */
  generatedText: string;
  /** The provider/model that produced it (for display + audit). */
  target: { providerName: string; modelName: string; modelId: string };
  usage?: AiGenerationResult['usage'];
  finishReason?: string;
  createdAt: number;
  /**
   * For `insert` proposals only: where to insert. Captured at generation time
   * so Apply is deterministic even if the cursor moved. Absent for replace/chat.
   */
  insertAnchor?: InsertAnchor;
}

/** Raised when a task is asked to run without the text it needs. */
export class AiAssistanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiAssistanceError';
  }
}

export interface RunAssistanceInput {
  task: AiTaskKind;
  /** Selection for replace tasks; full/partial chapter text for insert/chat. */
  sourceText: string;
  chapterTitle?: string;
  instruction?: string;
  /** Explicit model override; otherwise the task/global fallback is used. */
  modelId?: string;
  signal?: AbortSignal;
  /**
   * For `insert` tasks: where the continuation should be inserted. Captured by
   * the caller at generation time and carried onto the proposal unchanged.
   */
  insertAnchor?: InsertAnchor;
}

/**
 * AI Assistance service (P5).
 *
 * Sits between the UI/hooks and `AiService`. Its job is to turn a *task* into a
 * ready-to-review `AiProposal`:
 *
 *   1. pick the built-in task prompt,
 *   2. build messages and enforce that replace/insert tasks actually have text,
 *   3. call `AiService.generate`,
 *   4. package the result for preview — it never applies anything.
 *
 * Applying is a separate, explicit step performed by the editor integration so
 * the version-protection guarantees of P4 are respected (see `WritingPanel`).
 */
export class AiAssistanceService {
  private readonly aiService: AiService;

  constructor(aiService: AiService) {
    this.aiService = aiService;
  }

  /** Generates a proposal for a task. Performs no persistence. */
  async run(input: RunAssistanceInput): Promise<AiProposal> {
    const definition = TASK_PROMPTS[input.task];
    if (!definition) {
      throw new AiAssistanceError(`Unknown AI task "${input.task}".`);
    }

    const sourceText = input.sourceText ?? '';
    // Replace/insert tasks are meaningless without source text; fail early with
    // a clear message rather than sending an empty prompt and misusing quota.
    if ((definition.mode === 'replace-selection' || definition.mode === 'insert') && !sourceText.trim()) {
      throw new AiAssistanceError(
        definition.mode === 'replace-selection'
          ? 'Select some text first — this action modifies a selection.'
          : 'Write or load some text first so the AI has context to continue from.',
      );
    }

    const promptInput: TaskPromptInput = {
      sourceText,
      chapterTitle: input.chapterTitle,
      instruction: input.instruction,
    };
    const { system, user } = definition.build(promptInput);

    const messages: AiMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const { result, target } = await this.aiService.generate({
      task: input.task,
      messages,
      modelId: input.modelId,
      signal: input.signal,
    });

    return this.toProposal(input.task, definition, sourceText, result, target, input.insertAnchor);
  }

  /** Builds the display/manifest proposal from a raw result. */
  private toProposal(
    task: AiTaskKind,
    definition: TaskPromptDefinition,
    originalText: string,
    result: AiGenerationResult,
    target: ResolvedAiTarget,
    insertAnchor?: InsertAnchor,
  ): AiProposal {
    return {
      task,
      mode: definition.mode,
      originalText,
      // Strip accidental wrapping fences some models add despite instructions.
      generatedText: stripFences(result.content),
      target: {
        providerName: target.provider.name,
        modelName: target.model.displayName,
        modelId: target.model.modelId,
      },
      usage: result.usage,
      finishReason: result.finishReason,
      createdAt: Date.now(),
      // Only an insert proposal carries an anchor; carrying it for other modes
      // would be meaningless and could mislead the apply step.
      ...(definition.mode === 'insert' && insertAnchor ? { insertAnchor } : {}),
    };
  }
}

/**
 * Removes a leading/trailing triple-backtick fence if the whole response is
 * wrapped in one. Content the model returns should be prose, not markdown code.
 */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}
