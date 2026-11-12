import { z } from 'zod';

/**
 * AI configuration schemas (P5) — single source of truth.
 *
 * Three persisted entities, all DELIBERATELY decoupled from `NovelProject`:
 *
 *   - `AiProvider`   — an endpoint we can talk to (base URL, key, headers).
 *   - `AiModel`      — a model id available on a provider, plus its parameters.
 *   - `AiTaskConfig` — which model each AI task resolves to (singleton rows).
 *
 * Provider credentials are global workspace settings, never per-project: a user
 * configures their API key once and every novel uses it. This keeps the key out
 * of project exports/backups and prevents leaking it when a project is shared.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Provider types                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Supported provider protocols.
 *
 * `custom` is intentionally NOT a free-form protocol: it speaks the same
 * OpenAI-compatible Chat Completions dialect as `openai`, but lets the user
 * point at any base URL with custom headers. We do not claim support for
 * arbitrary protocols — see `docs/AI_HANDOFF.md`.
 */
export const AI_PROVIDER_TYPES = ['openai', 'anthropic', 'gemini', 'custom'] as const;

export const AiProviderTypeSchema = z.enum(AI_PROVIDER_TYPES);

export type AiProviderType = z.infer<typeof AiProviderTypeSchema>;

/** Upper bound for a stored API key (defensive; real keys are much shorter). */
export const MAX_API_KEY_CHARS = 4096;

/** Upper bound for a custom header value. */
export const MAX_HEADER_CHARS = 2048;

/** Maximum number of custom headers per provider. */
export const MAX_CUSTOM_HEADERS = 20;

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/** A single custom HTTP header. Values may contain the secret, so they are masked in the UI. */
export const AiCustomHeaderSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Header name is required')
      .max(80, 'Header name must be at most 80 characters'),
    value: z.string().max(MAX_HEADER_CHARS, `Header value must be at most ${MAX_HEADER_CHARS} characters`),
  })
  .strict();

export type AiCustomHeader = z.infer<typeof AiCustomHeaderSchema>;

/**
 * A configured AI provider.
 *
 * `baseUrl` is optional because each non-custom provider type has a sensible
 * default endpoint baked into its Adapter. `custom` requires it.
 */
export const AiProviderSchema = z
  .object({
    /** Stable primary key, prefixed (`prov_…`). */
    id: z.string().min(1, 'Provider id is required'),
    /** Human label shown in lists and pickers. */
    name: z.string().trim().min(1, 'Provider name is required').max(80, 'Provider name must be at most 80 characters'),
    /** Which protocol Adapter handles this provider. */
    providerType: AiProviderTypeSchema,
    /** Base URL override. Empty means "use the Adapter default". */
    baseUrl: z.string().trim().max(500, 'Base URL must be at most 500 characters'),
    /**
     * API key.
     *
     * Stored in IndexedDB in plain text. This is NOT a secure vault: any script
     * running on this origin (or anyone with local browser access) can read it.
     * The UI says so explicitly and never claims the key is encrypted.
     */
    apiKey: z.string().max(MAX_API_KEY_CHARS, `API key must be at most ${MAX_API_KEY_CHARS} characters`),
    /** Extra headers merged into every request (e.g. an OpenRouter referer). */
    customHeaders: z.array(AiCustomHeaderSchema).max(MAX_CUSTOM_HEADERS, `A provider may have at most ${MAX_CUSTOM_HEADERS} custom headers`),
    /** Whether this provider may be used for requests. */
    enabled: z.boolean(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((provider) => provider.updatedAt >= provider.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  })
  // `custom` cannot fall back to a built-in endpoint, so a base URL is required.
  .refine((provider) => provider.providerType !== 'custom' || provider.baseUrl.trim().length > 0, {
    message: 'A custom provider requires a base URL',
    path: ['baseUrl'],
  });

export type AiProvider = z.infer<typeof AiProviderSchema>;

/* -------------------------------------------------------------------------- */
/* Models                                                                     */
/* -------------------------------------------------------------------------- */

/** Maximum temperature most chat APIs accept. */
export const MAX_TEMPERATURE = 2;
export const MIN_TEMPERATURE = 0;

/** Request timeout bounds, in milliseconds. */
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 300_000;
/** Default timeout for a single generation request. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Bounds for a model's max output tokens. */
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 200_000;
export const DEFAULT_MAX_TOKENS = 2_048;
export const DEFAULT_TEMPERATURE = 0.8;

/**
 * A model available on a provider.
 *
 * Models are added MANUALLY: we do not assume every provider exposes a
 * model-listing endpoint, and calling one on connect would need extra auth
 * scopes. Manual entry is the documented baseline.
 */
export const AiModelSchema = z
  .object({
    /** Stable primary key, prefixed (`model_…`). */
    id: z.string().min(1, 'Model id is required'),
    /** Owning provider (`prov_…`). Models cascade-delete with their provider. */
    providerId: z.string().min(1, 'Model providerId is required'),
    /** The provider-side model identifier sent in requests (e.g. `gpt-4o-mini`). */
    modelId: z.string().trim().min(1, 'Model ID is required').max(200, 'Model ID must be at most 200 characters'),
    /** Friendly label shown in pickers. */
    displayName: z.string().trim().min(1, 'Display name is required').max(120, 'Display name must be at most 120 characters'),
    /** Whether this model may be selected. */
    enabled: z.boolean(),
    /** Default model for its provider (at most one per provider, enforced by the Service). */
    isDefault: z.boolean(),
    /** Sampling temperature. */
    temperature: z
      .number()
      .min(MIN_TEMPERATURE, `Temperature must be at least ${MIN_TEMPERATURE}`)
      .max(MAX_TEMPERATURE, `Temperature must be at most ${MAX_TEMPERATURE}`),
    /** Max output tokens requested. */
    maxTokens: z
      .number()
      .int('maxTokens must be an integer')
      .min(MIN_MAX_TOKENS, `maxTokens must be at least ${MIN_MAX_TOKENS}`)
      .max(MAX_MAX_TOKENS, `maxTokens must be at most ${MAX_MAX_TOKENS}`),
    /** Per-request timeout in milliseconds. */
    timeout: z
      .number()
      .int('Timeout must be an integer')
      .min(MIN_TIMEOUT_MS, `Timeout must be at least ${MIN_TIMEOUT_MS}ms`)
      .max(MAX_TIMEOUT_MS, `Timeout must be at most ${MAX_TIMEOUT_MS}ms`),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((model) => model.updatedAt >= model.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type AiModel = z.infer<typeof AiModelSchema>;

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * AI task kinds. Each can be bound to its own model; an unbound task falls back
 * to the GLOBAL default model.
 */
export const AI_TASK_KINDS = [
  'general-chat',
  'continue',
  'rewrite',
  'polish',
  'expand',
  'shorten',
  'suggestions',
] as const;

export const AiTaskKindSchema = z.enum(AI_TASK_KINDS);

export type AiTaskKind = z.infer<typeof AiTaskKindSchema>;

/**
 * A per-task model assignment.
 *
 * Stored as one row per task (keyed by `task` as the primary key) rather than a
 * single settings blob, so a partial update touches exactly one row and two
 * tabs cannot clobber each other's assignments.
 */
export const AiTaskConfigSchema = z
  .object({
    /** The task this row configures — also the primary key. */
    task: AiTaskKindSchema,
    /** Model id (`model_…`) bound to the task, or `null` for "use the default". */
    modelId: z.string().min(1).nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

export type AiTaskConfig = z.infer<typeof AiTaskConfigSchema>;

/**
 * Singleton row holding the GLOBAL default model.
 *
 * `id` is the constant `'global'`; keeping it in its own table avoids mixing a
 * global setting into per-task rows.
 */
export const GLOBAL_AI_CONFIG_ID = 'global';

export const AiGlobalConfigSchema = z
  .object({
    id: z.literal(GLOBAL_AI_CONFIG_ID),
    /** Global default model (`model_…`), or `null` when none is configured. */
    defaultModelId: z.string().min(1).nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

export type AiGlobalConfig = z.infer<typeof AiGlobalConfigSchema>;
