import { z } from 'zod';

/**
 * Narrative-planning domain schema (single source of truth for its types).
 *
 * A narrative plan belongs to exactly ONE project (`projectId`, unique index),
 * mirroring the world → project relationship. Types are DERIVED via `z.infer`.
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/**
 * Structural template of the story. Literal union (never a TS enum).
 * `custom` covers free-form structures that do not match a preset.
 */
export const NARRATIVE_STRUCTURES = [
  'three-act',
  'four-act',
  'hero-journey',
  'save-the-cat',
  'kishotenketsu',
  'seven-point',
  'custom',
] as const;

export const NarrativeStructureSchema = z.enum(NARRATIVE_STRUCTURES);

/** Where the overall plan stands. */
export const NARRATIVE_STATUSES = ['draft', 'in-progress', 'locked'] as const;

export const NarrativeStatusSchema = z.enum(NARRATIVE_STATUSES);

/** A single plot beat / arc marker inside the plan. */
export const PlotBeatSchema = z
  .object({
    /** Stable id so a beat survives reordering / renaming. */
    id: z.string().min(1, 'Beat id is required'),
    /** Beat name, e.g. "Inciting Incident". */
    title: z
      .string()
      .trim()
      .min(1, 'Beat title is required')
      .max(120, 'Beat title must be at most 120 characters'),
    /** What happens / why it matters. Empty allowed (name-only stub). */
    description: z.string().max(10_000, 'Beat description must be at most 10000 characters'),
    /** Approximate position along the story, 0–100 (percent). */
    position: z
      .number()
      .int('Position must be an integer')
      .min(0, 'Position must be at least 0')
      .max(100, 'Position must be at most 100'),
  })
  .strict();

const shortTextSchema = z.string().trim().max(200, 'Must be at most 200 characters');
const longTextSchema = z.string().max(20_000, 'Must be at most 20000 characters');

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

export const NarrativePlanSchema = z
  .object({
    /** Stable primary key, prefixed (e.g. `narr_...`). */
    id: z.string().min(1, 'Narrative plan id is required'),
    /** Owning project. Indexed and unique (one plan per project). */
    projectId: z.string().min(1, 'Narrative plan projectId is required'),

    /** One-line logline / premise. Empty allowed. */
    logline: shortTextSchema,
    /** Central thematic question. */
    theme: longTextSchema,
    /** The story's core situation, before conflict. */
    premise: longTextSchema,
    /** What stands in the protagonist's way. */
    centralConflict: longTextSchema,
    /** What is at stake if the protagonist fails. */
    stakes: longTextSchema,
    /** Intended resolution / ending. */
    ending: longTextSchema,

    structure: NarrativeStructureSchema,
    status: NarrativeStatusSchema,
    /** Ordered plot beats, rendered in array order. */
    beats: z.array(PlotBeatSchema).max(100, 'A plan may have at most 100 beats'),
    /** Recurring motifs, imagery or tonal keywords. */
    motifs: stringListSchema,

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  // A plan can never be modified before it was created.
  .refine((plan) => plan.updatedAt >= plan.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** Structural template of a narrative plan. */
export type NarrativeStructure = z.infer<typeof NarrativeStructureSchema>;
/** Lifecycle status of a narrative plan. */
export type NarrativeStatus = z.infer<typeof NarrativeStatusSchema>;
/** A single plot beat. */
export type PlotBeat = z.infer<typeof PlotBeatSchema>;
/** A project's narrative plan. */
export type NarrativePlan = z.infer<typeof NarrativePlanSchema>;
