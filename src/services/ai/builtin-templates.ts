import type { AiTaskKind, PromptVariable } from '@/types';

/**
 * Built-in prompt templates seeded into a project on first use (P6).
 *
 * These are ORDINARY, fully-editable templates — once seeded they are rows in
 * the project exactly like user-created ones. They are derived from the P5 fixed
 * task prompts (`task-prompts.ts`) so the Prompt Engineering Center starts with
 * useful, working defaults that reproduce the shipped behaviour.
 *
 * Bodies use `{{variable}}` placeholders. Every referenced variable is declared
 * below; an undeclared placeholder would fail validation (see prompt-render.ts).
 */
export interface BuiltinTemplate {
  name: string;
  description: string;
  category: string;
  content: string;
  variables: PromptVariable[];
  taskKind: AiTaskKind;
  isDefault?: boolean;
}

const VAR_SOURCE: PromptVariable = {
  name: 'sourceText',
  description: 'The passage or selection the task operates on.',
  required: false,
};

const VAR_CHAPTER: PromptVariable = {
  name: 'chapterTitle',
  description: 'Title of the current chapter, if any.',
  required: false,
};

const VAR_INSTRUCTION: PromptVariable = {
  name: 'instruction',
  description: 'Extra user instruction.',
  required: false,
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    name: 'Continue writing',
    description: 'Continue the passage naturally in the current voice.',
    category: 'Continuation',
    taskKind: 'continue',
    isDefault: true,
    content:
      'Chapter: {{chapterTitle}}\n\n' +
      'Continue the following passage naturally, writing the next few paragraphs in the same voice, tense and point of view.\n\n' +
      'Existing text:\n"""\n{{sourceText}}\n"""',
    variables: [VAR_CHAPTER, VAR_SOURCE],
  },
  {
    name: 'Rewrite',
    description: 'Rephrase the selection while keeping its meaning.',
    category: 'Rewrite',
    taskKind: 'rewrite',
    isDefault: true,
    content:
      'Instruction: {{instruction}}\n\n' +
      'Rewrite the following text in a clearer, more vivid way, preserving its meaning:\n"""\n{{sourceText}}\n"""',
    variables: [VAR_INSTRUCTION, VAR_SOURCE],
  },
  {
    name: 'Polish',
    description: 'Tighten grammar, rhythm and word choice.',
    category: 'Polish',
    taskKind: 'polish',
    isDefault: true,
    content:
      'Polish this text for grammar, rhythm and word choice without changing its meaning:\n"""\n{{sourceText}}\n"""',
    variables: [VAR_SOURCE],
  },
  {
    name: 'Expand',
    description: 'Add sensory and emotional detail.',
    category: 'Expand',
    taskKind: 'expand',
    isDefault: true,
    content:
      'Instruction: {{instruction}}\n\n' +
      'Expand this text with more sensory and emotional detail:\n"""\n{{sourceText}}\n"""',
    variables: [VAR_INSTRUCTION, VAR_SOURCE],
  },
  {
    name: 'Shorten',
    description: 'Condense the text while keeping the essentials.',
    category: 'Shorten',
    taskKind: 'shorten',
    isDefault: true,
    content:
      'Instruction: {{instruction}}\n\n' +
      'Shorten this text, keeping the essential meaning and voice:\n"""\n{{sourceText}}\n"""',
    variables: [VAR_INSTRUCTION, VAR_SOURCE],
  },
  {
    name: 'Writing suggestions',
    description: 'Get concrete ideas to improve the current passage.',
    category: 'Analysis',
    taskKind: 'suggestions',
    isDefault: true,
    content:
      'Chapter: {{chapterTitle}}\n\n' +
      'Give 3–5 concrete, actionable suggestions for the following text. Be specific to the text.\n\n' +
      'Text:\n"""\n{{sourceText}}\n"""',
    variables: [VAR_CHAPTER, VAR_SOURCE],
  },
  {
    name: 'Ask about writing',
    description: 'Ask a question or discuss craft, plot and characters.',
    category: 'General Writing',
    taskKind: 'general-chat',
    isDefault: true,
    content:
      'Chapter: {{chapterTitle}}\n\n' +
      'Current text:\n"""\n{{sourceText}}\n"""\n\n' +
      'Question: {{instruction}}',
    variables: [VAR_CHAPTER, VAR_SOURCE, VAR_INSTRUCTION],
  },
];
