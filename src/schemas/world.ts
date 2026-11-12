import { z } from 'zod';

/**
 * World-building domain schemas (single source of truth for world types).
 *
 * A world belongs to exactly ONE project (`projectId`). Types are DERIVED
 * from these schemas via `z.infer` — never hand-written in parallel.
 *
 * Same tsconfig constraints as the project schema:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/** A single free-form section of the world (e.g. "Geography", "Magic"). */
export const WorldSectionSchema = z
  .object({
    /** Stable id so a section survives reordering / renaming. */
    id: z.string().min(1, 'Section id is required'),
    /** Display heading, e.g. "Geography". */
    title: z
      .string()
      .trim()
      .min(1, 'Section title is required')
      .max(80, 'Section title must be at most 80 characters'),
    /** Section body. Empty is allowed (a heading may be created first). */
    content: z.string().max(20_000, 'Section body must be at most 20000 characters'),
  })
  .strict();

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(200, 'Title must be at most 200 characters');

const overviewSchema = z.string().max(20_000, 'Overview must be at most 20000 characters');

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * The world/setting record of one project.
 *
 * Exactly one world per project: `id` is derived from the project, and a
 * unique `projectId` index enforces the 1:1 relationship at the database level
 * (see `src/db/database.ts`, version 2).
 */
export const WorldSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `world_...`). */
    id: z.string().min(1, 'World id is required'),
    /** Owning project. Indexed and unique. */
    projectId: z.string().min(1, 'World projectId is required'),
    title: titleSchema,
    /** High-level setting summary. Empty string is allowed. */
    overview: overviewSchema,
    /** Free-form named sections, rendered in array order. */
    sections: z.array(WorldSectionSchema).max(50, 'A world may have at most 50 sections'),
    /** Themes, moods or core concepts. */
    themes: stringListSchema,
    settings: z
      .object({
        /** Era / time period, e.g. "Age of Sail". */
        era: z.string().trim().max(120).optional(),
        /** Technology level or magic-system summary. */
        technology: z.string().trim().max(200).optional(),
      })
      .strict(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  // A world can never be modified before it was created.
  .refine((world) => world.updatedAt >= world.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** A single named section of a world. */
export type WorldSection = z.infer<typeof WorldSectionSchema>;
/** A project's world/ setting record. */
export type World = z.infer<typeof WorldSchema>;
