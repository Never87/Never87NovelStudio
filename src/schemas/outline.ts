import { z } from 'zod';

/**
 * Outline domain schemas (single source of truth for outline types).
 *
 * Hierarchy: Project → Volume → Chapter. A chapter may optionally reference a
 * Narrative `PlotBeat` by id — the PRIMARY KEY of the beat, never a copy of its
 * text, so narrative information is authored once and linked, not duplicated.
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/** Where a chapter stands in the drafting lifecycle. */
export const CHAPTER_STATUSES = ['planned', 'drafting', 'drafted', 'revised', 'final'] as const;

export const ChapterStatusSchema = z.enum(CHAPTER_STATUSES);

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(200, 'Title must be at most 200 characters');

const bodySchema = z.string().max(20_000, 'Must be at most 20000 characters');

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/** A single chapter inside a volume. */
export const ChapterSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `chap_...`). */
    id: z.string().min(1, 'Chapter id is required'),
    /** Owning volume. */
    volumeId: z.string().min(1, 'Chapter volumeId is required'),
    /** Owning project — denormalised so a project can be queried directly. */
    projectId: z.string().min(1, 'Chapter projectId is required'),
    title: titleSchema,
    /** Position inside its volume (ascending). Unique per volume by convention. */
    order: z
      .number()
      .int('Order must be an integer')
      .nonnegative('Order must be non-negative'),
    /** One-line summary shown in the outline tree. Empty allowed. */
    summary: z.string().max(1_000, 'Summary must be at most 1000 characters'),
    /** What this chapter must accomplish. */
    goal: bodySchema,
    /** Key events that happen. */
    keyEvents: bodySchema,
    /** The hook that pulls the reader into the next chapter. */
    endingHook: bodySchema,
    status: ChapterStatusSchema,
    /** Optional link to a Narrative PlotBeat (id only — text lives there). */
    plotBeatId: z.string().min(1).optional(),
    /** Optional link to characters appearing in this chapter. */
    characterIds: z.array(z.string().min(1)).max(200),
    /** Free-form labels. */
    tags: stringListSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((chapter) => chapter.updatedAt >= chapter.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** A volume groups chapters. */
export const VolumeSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `vol_...`). */
    id: z.string().min(1, 'Volume id is required'),
    projectId: z.string().min(1, 'Volume projectId is required'),
    title: titleSchema,
    summary: z.string().max(2_000, 'Summary must be at most 2000 characters'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((volume) => volume.updatedAt >= volume.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** Lifecycle status of a chapter. */
export type ChapterStatus = z.infer<typeof ChapterStatusSchema>;
/** A chapter within a volume. */
export type Chapter = z.infer<typeof ChapterSchema>;
/** A volume grouping chapters. */
export type Volume = z.infer<typeof VolumeSchema>;
