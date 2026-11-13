import { z } from 'zod';

/**
 * AI Context Manager schemas (P6) — single source of truth.
 *
 * The Context Manager controls the context supplied to existing P5 AI tasks. It
 * is NOT a second AI execution engine: `ContextAssemblyService` resolves the
 * four layers and produces the logical request consumed by the P5 path.
 *
 * Four layers:
 *   1. base        — stable project facts (premise, theme, world highlights).
 *   2. dynamic     — task-scoped facts (current chapter/scene/selection).
 *   3. retrieved   — project records pulled in as reference (characters,
 *                    locations, world rules, timeline, …).
 *   4. instructions — explicit user instructions (persistent / task / temporary).
 *
 * Persistence strategy (R3): we PERSIST REFERENCES and lightweight metadata,
 * never copies of whole project entities. Base/dynamic/retrieved items reference
 * an existing entity via `sourceId` and are resolved through the existing
 * services at assembly time. Only user-authored item content (notes/instructions)
 * is stored verbatim.
 *
 * Constraint on layer: Base and Retrieved items reference existing entities;
 * Dynamic items are generated per task and not persisted individually (they are
 * derived during assembly); Instructions may be persisted (persistent/task) or
 * supplied transiently (temporary, never stored).
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Enumerations                                                               */
/* -------------------------------------------------------------------------- */

export const CONTEXT_LAYERS = ['base', 'dynamic', 'retrieved', 'instructions'] as const;
export const ContextLayerSchema = z.enum(CONTEXT_LAYERS);
export type ContextLayer = z.infer<typeof ContextLayerSchema>;

/**
 * Where a context item came from.
 *
 * The `sourceType` drives how `sourceId` is resolved during assembly:
 *   - `project`       → the project row itself (no sourceId)
 *   - `narrative`     → the project's `NarrativePlan` (no sourceId; 1:1)
 *   - `world`         → the project's `World` (no sourceId; 1:1)
 *   - `character`     → a `Character` by id
 *   - `chapter`       → a `Chapter` by id
 *   - `scene`         → a `Scene` by id
 *   - `timeline`      → reserved for P3 timeline events (no source yet in P6)
 *   - `note`          → user-authored free text held in `content` (manual add)
 *   - `instruction`   → user instruction (held in `content`)
 */
export const CONTEXT_SOURCE_TYPES = [
  'project',
  'narrative',
  'world',
  'character',
  'chapter',
  'scene',
  'timeline',
  'note',
  'instruction',
] as const;
export const ContextSourceTypeSchema = z.enum(CONTEXT_SOURCE_TYPES);
export type ContextSourceType = z.infer<typeof ContextSourceTypeSchema>;

/**
 * How strongly an item is bound to a request.
 *
 *   - `required`  — must be included; if it cannot fit within budget the
 *                   assembly reports an explicit overflow rather than dropping it.
 *   - `normal`    — optional; dropped before `required` when trimming to budget.
 *   - `low`       — first to be trimmed.
 *
 * User instructions are handled separately and are never trimmed silently.
 */
export const CONTEXT_PRIORITIES = ['required', 'normal', 'low'] as const;
export const ContextPrioritySchema = z.enum(CONTEXT_PRIORITIES);
export type ContextPriority = z.infer<typeof ContextPrioritySchema>;

/* -------------------------------------------------------------------------- */
/* Persisted context item (references only)                                   */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * A persisted, user-controlled context item.
 *
 * This records WHICH existing entity (or note) to include, its layer, whether it
 * is enabled, and its priority — NOT a copy of the entity. The entity's current
 * content is resolved at assembly time, so an edited character is always
 * reflected and no stale duplicate can drift.
 *
 * Persisted items never carry `dynamic` layer data: dynamic context is derived
 * per request and is not stored here.
 */
export const ContextItemSchema = z
  .object({
    /** Stable primary key, prefixed (`ctx_…`). */
    id: z.string().min(1, 'Context item id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Context item projectId is required'),

    /** Layer this item belongs to (base / retrieved / instructions). */
    layer: ContextLayerSchema,
    /** How the source is resolved. */
    sourceType: ContextSourceTypeSchema,
    /** Id of the referenced entity, when applicable (null for 1:1/notes). */
    sourceId: z.string().min(1).nullable(),
    /** Display name / label — a hint, the authoritative name is resolved live. */
    sourceLabel: z.string().trim().max(200).default(''),

    /**
     * Only meaningful for user-authored sources (`note` / `instruction`). Empty
     * for reference sources, whose content is resolved from the entity.
     */
    content: z.string().max(40_000, 'Content must be at most 40000 characters').default(''),

    priority: ContextPrioritySchema,
    enabled: z.boolean(),

    /** Whether this instruction is persistent (saved) vs task-scoped. */
    persistent: z.boolean().default(false),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((item) => item.updatedAt >= item.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type ContextItem = z.infer<typeof ContextItemSchema>;

/* -------------------------------------------------------------------------- */
/* Per-project context configuration                                          */
/* -------------------------------------------------------------------------- */

/**
 * Lower bound for a user-configured input budget, to avoid a nonsensical 0.
 */
export const MIN_CONTEXT_BUDGET_TOKENS = 256;
/** Upper bound for the user-configured input budget (guard against typos). */
export const MAX_CONTEXT_BUDGET_TOKENS = 1_000_000;
/** Estimated tokens reserved for output when a model reports none. */
export const DEFAULT_REQUESTED_OUTPUT_TOKENS = 2_048;

/**
 * Per-project context configuration.
 *
 * One row per project (unique `projectId`). Holds the token budget, the layers
 * the user wants active, and the model's declared context-window override when
 * the configuration does not expose one (R4: never infer it from maxTokens).
 */
export const ContextConfigSchema = z
  .object({
    /** Stable primary key, prefixed (`ctxcfg_…`). */
    id: z.string().min(1, 'Context config id is required'),
    /** Owning project. Unique. */
    projectId: z.string().min(1, 'Context config projectId is required'),

    /**
     * Whether a token budget is enforced. When false the full context is used
     * (the preview still reports an estimate).
     */
    budgetEnabled: z.boolean(),
    /**
     * The user's desired input-token budget. Never allowed to exceed a KNOWN
     * model context window (enforced at assembly / clamped and warned).
     */
    inputBudgetTokens: z
      .number()
      .int('Budget must be an integer')
      .min(MIN_CONTEXT_BUDGET_TOKENS, `Budget must be at least ${MIN_CONTEXT_BUDGET_TOKENS}`)
      .max(MAX_CONTEXT_BUDGET_TOKENS, `Budget must be at most ${MAX_CONTEXT_BUDGET_TOKENS}`),

    /**
     * Context-window override in tokens. Used when the resolved model does not
     * declare its own context window. `null` means "unknown — do not invent one".
     */
    contextWindowOverrideTokens: z
      .number()
      .int('Context window must be an integer')
      .positive('Context window must be positive')
      .max(MAX_CONTEXT_BUDGET_TOKENS)
      .nullable(),

    /** Token allowance reserved for the model's output. */
    requestedOutputTokens: z
      .number()
      .int('Output token allowance must be an integer')
      .nonnegative('Output token allowance must be non-negative')
      .max(MAX_CONTEXT_BUDGET_TOKENS),

    /** Which layers are active. Disabling a layer omits it from assembly. */
    enabledLayers: z
      .object({
        base: z.boolean(),
        dynamic: z.boolean(),
        retrieved: z.boolean(),
        instructions: z.boolean(),
      })
      .strict(),

    /** Persistent project-wide instruction text (Layer 4, always-on when enabled). */
    persistentInstructions: z
      .string()
      .max(40_000, 'Instructions must be at most 40000 characters')
      .default(''),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((config) => config.updatedAt >= config.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type ContextConfig = z.infer<typeof ContextConfigSchema>;

/** Defaults for a freshly-created config. */
export function defaultContextConfig(projectId: string, timestamp: number): Omit<ContextConfig, 'id'> & { id: string } {
  return {
    id: '',
    projectId,
    budgetEnabled: true,
    inputBudgetTokens: 8_000,
    contextWindowOverrideTokens: null,
    requestedOutputTokens: DEFAULT_REQUESTED_OUTPUT_TOKENS,
    enabledLayers: { base: true, dynamic: true, retrieved: true, instructions: true },
    persistentInstructions: '',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
