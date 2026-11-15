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

/**
 * Public blurb / back-cover synopsis (P9 Batch D).
 *
 * DELIBERATELY SEPARATE from `description`:
 *   - `description` is the author's INTERNAL project summary (shown on the
 *     project card / detail page, used for the author's own orientation).
 *   - `blurb` is the PUBLIC marketing copy generated/edited in the Blurb
 *     Generator and intended for readers (EPUB back cover, Portfolio, stores).
 *
 * Empty string is allowed (a project may have no public blurb yet), and the
 * field is OPTIONAL so every pre-existing project row (which never had it)
 * remains valid without a data migration.
 */
const blurbSchema = z.string().trim().max(4_000, 'Blurb must be at most 4000 characters');

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
    /**
     * Public blurb / back-cover synopsis (P9 Batch D). Optional and separate
     * from the internal `description`; empty string is allowed. Omitted on any
     * project that has never generated one, so existing rows stay valid.
     */
    blurb: blurbSchema.optional(),
    /**
     * Optional cover image REFERENCE.
     *
     * Historically a URL or data URI (kept valid for backward compatibility).
     * New covers uploaded through the Book Covers module store their bytes in
     * the `coverAssets` table and set this field to `asset:<assetId>`, so the
     * column stays a short, JSON-safe string while the binary lives elsewhere.
     * Never a raw base64 payload for new covers (see `schemas/cover-asset.ts`).
     */
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


