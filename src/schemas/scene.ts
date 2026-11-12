import { z } from 'zod';

/**
 * Scene domain schema (single source of truth for scene types).
 *
 * A scene is the smallest unit of story and belongs to exactly ONE chapter
 * (`chapterId`, indexed). Its `projectId` is denormalised so scenes can be
 * queried and cascade-deleted per project without a join.
 *
 * Narrative information (plot beats) is NOT duplicated here — a scene links to
 * its chapter, and the chapter links to a PlotBeat by id.
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/** Where a scene stands in the design lifecycle. */
export const SCENE_STATUSES = ['planned', 'drafted', 'revised', 'final'] as const;

export const SceneStatusSchema = z.enum(SCENE_STATUSES);

/** Broad purpose of a scene in the story. Literal union (never a TS enum). */
export const SCENE_PURPOSES = [
  'setup',
  'conflict',
  'reveal',
  'turning-point',
  'resolution',
  'interlude',
] as const;

export const ScenePurposeSchema = z.enum(SCENE_PURPOSES);

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

export const SceneSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `scene_...`). */
    id: z.string().min(1, 'Scene id is required'),
    /** Owning chapter. */
    chapterId: z.string().min(1, 'Scene chapterId is required'),
    /** Owning project — denormalised for direct querying and cascade deletes. */
    projectId: z.string().min(1, 'Scene projectId is required'),

    title: titleSchema,
    /** Position inside its chapter (ascending). */
    order: z.number().int('Order must be an integer').nonnegative('Order must be non-negative'),
    /** One-line summary shown in lists. Empty allowed. */
    summary: z.string().max(1_000, 'Summary must be at most 1000 characters'),

    /** Where the scene takes place (free text — world sections are prose). */
    location: z.string().max(200, 'Location must be at most 200 characters'),
    /** In-world time, e.g. "Night, day 3". */
    timeOfDay: z.string().max(120, 'Time must be at most 120 characters'),
    /** POV character id, if chosen. */
    povCharacterId: z.string().min(1).optional(),
    /** Characters present in the scene. */
    characterIds: z.array(z.string().min(1)).max(200),

    /** What the POV wants in this scene. */
    goal: bodySchema,
    /** What opposes it. */
    conflict: bodySchema,
    /** The shift that happens. */
    turningPoint: bodySchema,
    /** Where the scene leaves things. */
    outcome: bodySchema,

    purpose: ScenePurposeSchema,
    status: SceneStatusSchema,
    /** Target word count for the scene, if planned. */
    targetWords: z
      .number()
      .int('Target words must be an integer')
      .nonnegative('Target words must be non-negative')
      .optional(),
    tags: stringListSchema,

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((scene) => scene.updatedAt >= scene.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** Lifecycle status of a scene. */
export type SceneStatus = z.infer<typeof SceneStatusSchema>;
/** Broad purpose of a scene. */
export type ScenePurpose = z.infer<typeof ScenePurposeSchema>;
/** A persisted scene. */
export type Scene = z.infer<typeof SceneSchema>;
