import { z } from 'zod';
import { AI_TASK_KINDS } from './ai';

/**
 * Prompt Engineering Center schemas (P6) — single source of truth.
 *
 * Two persisted entities, both PROJECT-ISOLATED via `projectId`:
 *
 *   - `PromptTemplate`        — the CURRENT snapshot of a reusable prompt plus
 *                               its variables, category, task association and
 *                               optional provider/model *preferences*.
 *   - `PromptTemplateVersion` — an IMMUTABLE historical snapshot. Every
 *                               meaningful content change appends one record;
 *                               restoring an old version appends a new one.
 *                               Template versions are entirely separate from
 *                               manuscript `DraftVersion` records (P4).
 *
 * Constraint R1: versions live in their own table (append-only). The template
 * record keeps a `currentVersionId` pointer plus the current content snapshot,
 * so reading a template never needs to join or walk its history.
 *
 * Constraint R2: `providerId` / `modelId` are PREFERENCES, not an independent
 * model resolver. Actual resolution always goes through `AiService.resolveTarget`.
 *
 * Constraint R5: the render/assembly pipeline is the only logical request
 * builder; these schemas only describe stored data, never a second pipeline.
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Categories                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Well-known template categories.
 *
 * These seed the picker but are NOT a closed set: `category` is stored as a
 * free-form string so users can organise templates under their own headings
 * without a schema migration (the "Custom" requirement).
 */
export const PROMPT_CATEGORY_PRESETS = [
  'General Writing',
  'Continuation',
  'Rewrite',
  'Polish',
  'Expand',
  'Shorten',
  'Character',
  'World Building',
  'Plot',
  'Analysis',
  'Custom',
] as const;

export type PromptCategoryPreset = (typeof PROMPT_CATEGORY_PRESETS)[number];

/* -------------------------------------------------------------------------- */
/* Variables                                                                  */
/* -------------------------------------------------------------------------- */

/** Variable name grammar: identifiers only, so parsing is unambiguous. */
export const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export const MAX_TEMPLATE_CONTENT_CHARS = 40_000;
export const MAX_TEMPLATE_DESCRIPTION_CHARS = 2_000;
export const MAX_TEMPLATE_VARIABLES = 64;
export const MAX_TEMPLATE_NAME_CHARS = 120;

/**
 * A declared template variable.
 *
 * Only DECLARED variables may appear in a template body. Rendering is STRICT:
 * a required variable with no value is an explicit error, and an undeclared
 * `{{name}}` is a validation error rather than being silently dropped
 * (see `PromptRenderService`).
 */
export const PromptVariableSchema = z
  .object({
    /** Identifier, e.g. `chapterTitle`. Must satisfy `VARIABLE_NAME_PATTERN`. */
    name: z
      .string()
      .trim()
      .min(1, 'Variable name is required')
      .max(80, 'Variable name must be at most 80 characters')
      .regex(VARIABLE_NAME_PATTERN, 'Variable names may only contain letters, digits and underscores, and must not start with a digit'),
    /** Short human explanation shown in the UI. */
    description: z.string().trim().max(200, 'Description must be at most 200 characters').default(''),
    /** When true, a missing value blocks rendering. */
    required: z.boolean().default(false),
    /** Optional default used only when the caller supplies no value. */
    defaultValue: z.string().max(MAX_TEMPLATE_CONTENT_CHARS).optional(),
  })
  .strict();

export type PromptVariable = z.infer<typeof PromptVariableSchema>;

/* -------------------------------------------------------------------------- */
/* Template                                                                   */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * A reusable prompt template (current snapshot).
 *
 * `projectId` isolates templates per project — templates are project-owned data,
 * never global settings. Provider credentials remain global (P5); a template
 * only *references* a provider/model by id as a preference.
 */
export const PromptTemplateSchema = z
  .object({
    /** Stable primary key, prefixed (`ptpl_…`). */
    id: z.string().min(1, 'Template id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Template projectId is required'),

    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(MAX_TEMPLATE_NAME_CHARS, `Name must be at most ${MAX_TEMPLATE_NAME_CHARS} characters`),
    description: z.string().max(MAX_TEMPLATE_DESCRIPTION_CHARS, `Description must be at most ${MAX_TEMPLATE_DESCRIPTION_CHARS} characters`),
    /** Free-form category; see `PROMPT_CATEGORY_PRESETS` for suggested values. */
    category: z.string().trim().min(1, 'Category is required').max(80, 'Category must be at most 80 characters'),

    /** The template body, containing `{{variable}}` placeholders. */
    content: z.string().max(MAX_TEMPLATE_CONTENT_CHARS, `Template must be at most ${MAX_TEMPLATE_CONTENT_CHARS} characters`),
    /** Declared variables. Undeclared `{{x}}` in the body is a validation error. */
    variables: z.array(PromptVariableSchema).max(MAX_TEMPLATE_VARIABLES, `A template may declare at most ${MAX_TEMPLATE_VARIABLES} variables`),

    /**
     * The AI task this template is associated with, or `null` for a template
     * that is only used manually/for testing. A task may have at most one
     * default template (enforced by the Service via `isDefault`).
     */
    taskKind: z.enum(AI_TASK_KINDS).nullable(),

    /** Optional provider preference (`prov_…`). NOT a resolver (R2). */
    providerId: z.string().min(1).nullable(),
    /** Optional model preference (`model_…`). NOT a resolver (R2). */
    modelId: z.string().min(1).nullable(),

    /** Whether this is the default template for its `taskKind`. */
    isDefault: z.boolean(),
    /** Disabled templates cannot be selected for execution. */
    enabled: z.boolean(),

    /** The current version id (`ptv_…`) this snapshot corresponds to. */
    currentVersionId: z.string().min(1, 'currentVersionId is required'),
    /** Monotonic version number of the current snapshot (starts at 1). */
    version: z.number().int('Version must be an integer').positive('Version must be positive'),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((template) => template.updatedAt >= template.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type PromptTemplate = z.infer<typeof PromptTemplateSchema>;

/* -------------------------------------------------------------------------- */
/* Version (append-only)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An immutable historical snapshot of a template's content-bearing fields.
 *
 * Stored in its own table so the template row stays small and history is never
 * accidentally rewritten. Restoring a version creates a NEW version record; the
 * old ones are never mutated or deleted by ordinary edits.
 */
export const PromptTemplateVersionSchema = z
  .object({
    /** Stable primary key, prefixed (`ptv_…`). */
    id: z.string().min(1, 'Version id is required'),
    /** The template this snapshot belongs to. Indexed. */
    templateId: z.string().min(1, 'templateId is required'),
    /** Owning project — denormalised for isolation and cascade cleanup. */
    projectId: z.string().min(1, 'Version projectId is required'),
    /** Monotonic version number within the template (1-based). */
    version: z.number().int('Version must be an integer').positive('Version must be positive'),

    // Snapshot of the content-bearing fields at capture time.
    name: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    content: z.string(),
    variables: z.array(PromptVariableSchema),
    taskKind: z.enum(AI_TASK_KINDS).nullable(),

    /** A short label describing why this version exists. */
    reason: z.enum(['created', 'edited', 'restored', 'imported']),
    /** Optional human note (kept short — it is a label, not a document). */
    label: z.string().trim().max(200).default(''),

    createdAt: timestampSchema,
  })
  .strict();

export type PromptTemplateVersion = z.infer<typeof PromptTemplateVersionSchema>;

/* -------------------------------------------------------------------------- */
/* Import / export (R6)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A portable template bundle for JSON import/export.
 *
 * The format is intentionally simple and self-describing. On import the Service
 * validates each entry with `PromptTemplateSchema` and NEVER copies `providerId`
 * or `modelId` blindly — provider/model preferences are re-validated against the
 * local AI configuration, and API keys are never present in this format.
 */
export const PROMPT_BUNDLE_FORMAT = 'never87.prompt-templates';
export const PROMPT_BUNDLE_VERSION = 1;

/** The per-template payload inside an export bundle (no projectId/ids/version state). */
export const PromptBundleEntrySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(MAX_TEMPLATE_NAME_CHARS, `Name must be at most ${MAX_TEMPLATE_NAME_CHARS} characters`),
    description: z.string().max(MAX_TEMPLATE_DESCRIPTION_CHARS).default(''),
    category: z.string().trim().min(1, 'Category is required').max(80),
    content: z.string().max(MAX_TEMPLATE_CONTENT_CHARS),
    variables: z.array(PromptVariableSchema).max(MAX_TEMPLATE_VARIABLES).default([]),
    taskKind: z.enum(AI_TASK_KINDS).nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict();

export type PromptBundleEntry = z.infer<typeof PromptBundleEntrySchema>;

export const PromptBundleSchema = z
  .object({
    format: z.literal(PROMPT_BUNDLE_FORMAT),
    formatVersion: z.literal(PROMPT_BUNDLE_VERSION),
    /** When the bundle was produced (epoch ms). Informational only. */
    exportedAt: timestampSchema,
    templates: z.array(PromptBundleEntrySchema).min(1, 'A bundle must contain at least one template'),
  })
  .strict();

export type PromptBundle = z.infer<typeof PromptBundleSchema>;
