import { z } from 'zod';

/**
 * Project domain schemas (single source of truth for project types).
 *
 * Types are DERIVED from these schemas via `z.infer` — never hand-written in
 * parallel — so a schema change can never silently drift from its type.
 *
 * Constraints imposed by the project tsconfig:
 *   - `erasableSyntaxOnly`: no `enum`; statuses are literal unions instead.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/** Lifecycle status of a project. Literal union — never a TS enum. */
export const PROJECT_STATUSES = ['planning', 'writing', 'completed', 'archived'] as const;

export const ProjectStatusSchema = z.enum(PROJECT_STATUSES);

/**
 * Project-level settings.
 *
 * Intentionally minimal: only fields that the code actually reads exist today.
 * AI providers, editor preferences, export/publishing options are added in the
 * phase that implements them, each via a Dexie schema migration. Keeping this
 * object `.strict()` means callers cannot smuggle in unknown keys.
 */
export const ProjectSettingsSchema = z
  .object({
    /** Authors the UI may show while the project is still private/drafting. */
    author: z.string().trim().max(120).optional(),
    /** Free-form language tag, e.g. "en", "zh-CN". */
    language: z.string().trim().max(35).optional(),
  })
  .strict();

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(200, 'Title must be at most 200 characters');

const descriptionSchema = z.string().max(5_000, 'Description must be at most 5000 characters');

const stringListSchema = z.array(z.string().trim().min(1).max(60)).max(50);

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

export const NovelProjectSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `proj_...`). */
    id: z.string().min(1, 'Project id is required'),
    title: titleSchema,
    /** Empty string is allowed (a project may start untitled). */
    description: descriptionSchema,
    /** Optional cover image URL or data URI. */
    cover: z.string().min(1).max(2_000).optional(),
    status: ProjectStatusSchema,
    genre: stringListSchema,
    tags: stringListSchema,
    /** Target length in words. Positive integer; word counts are derived elsewhere. */
    targetWordCount: z.number().int().positive().optional(),
    settings: ProjectSettingsSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  // A project can never be modified before it was created.
  .refine((project) => project.updatedAt >= project.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** Status of a project. */
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
/** Project-level settings. */
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
/** A persisted novel project. */
export type NovelProject = z.infer<typeof NovelProjectSchema>;
