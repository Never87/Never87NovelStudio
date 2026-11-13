import type { PromptVariable } from '@/types';

/**
 * Prompt template variable parsing & strict rendering (P6).
 *
 * This is a PURE, dependency-free module so it can be unit-tested without a
 * database or React (see `scripts/p6-prompt-unit.cjs`). It is the single
 * implementation of "what a `{{variable}}` means", shared by the UI preview and
 * the execution path so a preview can never disagree with what is actually sent.
 *
 * Design rules (deliberately conservative):
 *   - Only DECLARED variables may appear. An undeclared `{{x}}` is a validation
 *     error, not a silent drop — silent drops are how prompts silently break.
 *   - Rendering is STRICT: a `required` variable with no value is an error.
 *   - Interpolation is SINGLE-PASS. A variable's value is never re-scanned for
 *     `{{…}}`, so user data can never inject new placeholders (no recursion).
 *   - Unknown/unfilled non-required variables render as their default, or as an
 *     empty string when they have none.
 */

/** A parsed occurrence of `{{name}}` in a template body. */
export interface ParsedPlaceholder {
  /** The trimmed variable name. */
  name: string;
  /** Start index of the full `{{…}}` token in the source. */
  start: number;
  /** End index (exclusive) of the full token. */
  end: number;
  /** The raw inner text between the braces (trimmed). */
  raw: string;
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Extracts every `{{name}}` placeholder from `content`, in order.
 *
 * Malformed braces (`{{`, `}}`, `{{ a b }}`) are ignored here; `validateTemplate`
 * reports them separately so the UI can explain the problem precisely.
 */
export function parsePlaceholders(content: string): ParsedPlaceholder[] {
  const out: ParsedPlaceholder[] = [];
  PLACEHOLDER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER.exec(content)) !== null) {
    out.push({
      name: match[1].trim(),
      raw: match[1].trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

/** The set of distinct variable names referenced by a template body. */
export function referencedVariableNames(content: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const placeholder of parsePlaceholders(content)) {
    if (!seen.has(placeholder.name)) {
      seen.add(placeholder.name);
      names.push(placeholder.name);
    }
  }
  return names;
}

export interface TemplateValidationIssue {
  /** Machine-readable kind so the UI can group/highlight issues. */
  kind: 'undeclared' | 'duplicate-declaration' | 'invalid-name' | 'malformed-braces';
  message: string;
  /** The offending variable name, when applicable. */
  name?: string;
}

const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validates the DECLARED variables against the template body.
 *
 * Returns every issue rather than throwing, so the editor can show all problems
 * at once. A template is renderable only when this returns an empty array.
 */
export function validateTemplate(
  content: string,
  variables: PromptVariable[],
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const declared = new Set<string>();

  for (const variable of variables) {
    if (!NAME_PATTERN.test(variable.name)) {
      issues.push({
        kind: 'invalid-name',
        name: variable.name,
        message: `Variable "${variable.name}" has an invalid name (letters, digits and underscores only, not starting with a digit).`,
      });
    }
    if (declared.has(variable.name)) {
      issues.push({
        kind: 'duplicate-declaration',
        name: variable.name,
        message: `Variable "${variable.name}" is declared more than once.`,
      });
    }
    declared.add(variable.name);
  }

  for (const name of referencedVariableNames(content)) {
    if (!declared.has(name)) {
      issues.push({
        kind: 'undeclared',
        name,
        message: `"{{${name}}}" is used but not declared as a variable.`,
      });
    }
  }

  // Detect stray, unbalanced braces that the placeholder regex ignores.
  const stripped = content.replace(PLACEHOLDER, '');
  if (/\{\{|\}\}/.test(stripped)) {
    issues.push({
      kind: 'malformed-braces',
      message: 'The template contains malformed braces ({{ or }} without a matching pair).',
    });
  }

  return issues;
}

/** Raised when rendering cannot produce a faithful result. */
export class PromptRenderError extends Error {
  readonly kind: 'undeclared' | 'missing-required' | 'invalid-template';
  readonly variableName?: string;

  constructor(
    kind: PromptRenderError['kind'],
    message: string,
    variableName?: string,
  ) {
    super(message);
    this.name = 'PromptRenderError';
    this.kind = kind;
    if (variableName !== undefined) this.variableName = variableName;
  }
}

export interface RenderResult {
  /** The final prompt text. */
  text: string;
  /** Variables that had no explicit value and used their default. */
  usedDefaults: string[];
  /** Non-required variables that were empty after defaults (rendered as ""). */
  emptyVariables: string[];
}

/**
 * Renders a template with the supplied values, STRICTLY.
 *
 * @throws PromptRenderError when the template references an undeclared variable,
 *         when a required variable has no value (and no default), or when the
 *         template itself is structurally invalid.
 */
export function renderTemplate(
  content: string,
  variables: PromptVariable[],
  values: Record<string, string | undefined>,
): RenderResult {
  const issues = validateTemplate(content, variables);
  if (issues.length > 0) {
    throw new PromptRenderError(
      'invalid-template',
      `This template cannot be rendered: ${issues.map((issue) => issue.message).join(' ')}`,
    );
  }

  const declaredByName = new Map(variables.map((variable) => [variable.name, variable] as const));
  const usedDefaults: string[] = [];
  const emptyVariables: string[] = [];

  // Resolve each declared variable to its effective string value ONCE. Because
  // we substitute from this table (never re-scan substituted text), a value can
  // never inject a new placeholder.
  const resolved = new Map<string, string>();
  for (const variable of variables) {
    const provided = values[variable.name];
    if (provided !== undefined) {
      resolved.set(variable.name, provided);
      continue;
    }
    if (variable.defaultValue !== undefined) {
      resolved.set(variable.name, variable.defaultValue);
      usedDefaults.push(variable.name);
      continue;
    }
    if (variable.required) {
      throw new PromptRenderError(
        'missing-required',
        `The variable "${variable.name}" is required but has no value.`,
        variable.name,
      );
    }
    resolved.set(variable.name, '');
    emptyVariables.push(variable.name);
  }

  // Single-pass replacement using the stored values table.
  let text = '';
  let cursor = 0;
  for (const placeholder of parsePlaceholders(content)) {
    text += content.slice(cursor, placeholder.start);
    // Everything inside a placeholder is a declared name (validated above).
    text += resolved.get(declaredByName.get(placeholder.name)?.name ?? placeholder.name) ?? '';
    cursor = placeholder.end;
  }
  text += content.slice(cursor);

  return { text, usedDefaults, emptyVariables };
}

/**
 * Coerces arbitrary caller-provided values into the string map `renderTemplate`
 * expects, dropping non-string/undefined entries. Keeps the API forgiving of
 * `{ chapterTitle: undefined }` without scattering `?? undefined` checks.
 */
export function normalizeValues(values: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'string' ? value : String(value);
  }
  return out;
}
