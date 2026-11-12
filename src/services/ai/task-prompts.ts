import type { AiTaskKind } from '@/types';

/**
 * Built-in task prompts for P5 AI Assistance.
 *
 * IMPORTANT SCOPE NOTE: these are a small, fixed set of task templates, NOT a
 * Prompt Engineering Center. P6 will introduce editable prompt templates,
 * variables, versioning and a context manager. Do not describe these as such.
 */
export interface TaskPromptDefinition {
  task: AiTaskKind;
  label: string;
  /** Short description shown in the UI. */
  description: string;
  /**
   * How the result should be applied.
   *   - `insert`: append the result as new prose (continue writing).
   *   - `replace-selection`: swap the selected text (rewrite/polish/expand/shorten).
   *   - `chat`: conversational, never auto-applied.
   */
  mode: 'insert' | 'replace-selection' | 'chat';
  /** Builds the system + user messages for the request. */
  build: (input: TaskPromptInput) => { system: string; user: string };
}

export interface TaskPromptInput {
  /** The text the task operates on (selection or full chapter). */
  sourceText: string;
  /** Chapter title, if the editor is operating on a chapter. */
  chapterTitle?: string;
  /** Free-form user instruction (chat / suggestions). */
  instruction?: string;
}

const SYSTEM_PROSE =
  'You are a professional fiction-writing assistant embedded in a novel editor. ' +
  'Match the voice, tense and point of view of the supplied text. ' +
  'Return ONLY the requested prose with no preamble, commentary, quotes or markdown fences.';

/**
 * The built-in task table.
 *
 * Each entry is intentionally data-only so the UI can render a consistent task
 * list and P6 can later replace/extend it with user templates.
 */
export const TASK_PROMPTS: Record<AiTaskKind, TaskPromptDefinition> = {
  'general-chat': {
    task: 'general-chat',
    label: 'Ask about writing',
    description: 'Ask a question or discuss craft, plot and characters.',
    mode: 'chat',
    build: ({ instruction, sourceText, chapterTitle }) => ({
      system:
        'You are a helpful fiction-writing assistant in a novel editor. Answer concisely and concretely. ' +
        'If given manuscript context, use it, but do not rewrite it unless asked.',
      user: [
        chapterTitle ? `Chapter: ${chapterTitle}` : '',
        sourceText ? `Current text:\n"""\n${sourceText}\n"""` : '',
        instruction ? `Question: ${instruction}` : 'What should I improve in this passage?',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }),
  },
  continue: {
    task: 'continue',
    label: 'Continue writing',
    description: 'Continue the passage in the current voice.',
    mode: 'insert',
    build: ({ sourceText, chapterTitle }) => ({
      system: SYSTEM_PROSE,
      user: [
        chapterTitle ? `Chapter: ${chapterTitle}` : '',
        'Continue the following passage naturally, writing the next few paragraphs.',
        sourceText ? `Existing text:\n"""\n${sourceText}\n"""` : 'Start the chapter with a strong opening.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }),
  },
  rewrite: {
    task: 'rewrite',
    label: 'Rewrite',
    description: 'Rephrase the selection while keeping its meaning.',
    mode: 'replace-selection',
    build: ({ sourceText, instruction }) => ({
      system: SYSTEM_PROSE,
      user: [
        instruction ? `Instruction: ${instruction}` : 'Rewrite the following text in a clearer, more vivid way.',
        `Text:\n"""\n${sourceText}\n"""`,
      ].join('\n\n'),
    }),
  },
  polish: {
    task: 'polish',
    label: 'Polish',
    description: 'Tighten grammar, rhythm and word choice.',
    mode: 'replace-selection',
    build: ({ sourceText }) => ({
      system: SYSTEM_PROSE,
      user: `Polish this text for grammar, rhythm and word choice without changing its meaning:\n"""\n${sourceText}\n"""`,
    }),
  },
  expand: {
    task: 'expand',
    label: 'Expand',
    description: 'Add sensory and emotional detail.',
    mode: 'replace-selection',
    build: ({ sourceText, instruction }) => ({
      system: SYSTEM_PROSE,
      user: [
        instruction ? `Instruction: ${instruction}` : 'Expand this text with more sensory and emotional detail.',
        `Text:\n"""\n${sourceText}\n"""`,
      ].join('\n\n'),
    }),
  },
  shorten: {
    task: 'shorten',
    label: 'Shorten',
    description: 'Condense the text while keeping the essentials.',
    mode: 'replace-selection',
    build: ({ sourceText, instruction }) => ({
      system: SYSTEM_PROSE,
      user: [
        instruction ? `Instruction: ${instruction}` : 'Shorten this text, keeping the essential meaning and voice.',
        `Text:\n"""\n${sourceText}\n"""`,
      ].join('\n\n'),
    }),
  },
  suggestions: {
    task: 'suggestions',
    label: 'Writing suggestions',
    description: 'Get concrete ideas to improve the current passage.',
    mode: 'chat',
    build: ({ sourceText, chapterTitle }) => ({
      system:
        'You are a knowledgeable fiction editor. Give 3–5 concrete, actionable suggestions. Be specific to the text.',
      user: [
        chapterTitle ? `Chapter: ${chapterTitle}` : '',
        sourceText ? `Text:\n"""\n${sourceText}\n"""` : 'Suggest general ways to strengthen the opening of a novel chapter.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    }),
  },
};

/** All task definitions in a stable display order. */
export const TASK_PROMPT_LIST: TaskPromptDefinition[] = [
  TASK_PROMPTS['general-chat'],
  TASK_PROMPTS.continue,
  TASK_PROMPTS.rewrite,
  TASK_PROMPTS.polish,
  TASK_PROMPTS.expand,
  TASK_PROMPTS.shorten,
  TASK_PROMPTS.suggestions,
];
