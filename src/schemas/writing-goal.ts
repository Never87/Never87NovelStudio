import { z } from 'zod';

/**
 * Writing goal schema (Dashboard fix — Round 1).
 *
 * A `WritingGoal` is a REAL, persisted daily word-target setting. It exists so
 * the Dashboard's "Writing Goal" card and the (future) "Writing Goals" page
 * SHARE one source of truth instead of each inventing its own numbers — a goal
 * set in one place is immediately visible in the other.
 *
 * ## Scope
 *
 * The Dashboard is a WORKSPACE overview (no single "current project"), so the
 * goal it displays is a WORKSPACE-WIDE daily target: one singleton row with the
 * fixed id `'global'`. This is deliberately stored in the database (not in
 * `localStorage`) so it is part of the same persistence surface as writing data
 * and can be reused by any module that imports the goal service.
 *
 * Per-project goals can be layered on later WITHOUT a migration change by
 * storing additional rows keyed by a different id; today only the global row
 * is created. The schema is intentionally generic (`scope`) so that evolution
 * is additive.
 *
 * Constraints mirror the rest of the codebase: no enums (literal unions), and
 * timestamps are non-negative integer epoch milliseconds.
 */

/** The fixed primary key of the workspace-wide goal singleton. */
export const GLOBAL_WRITING_GOAL_ID = 'global';

/** Where a goal applies. Today only a workspace-wide goal is created. */
export const WRITING_GOAL_SCOPES = ['global'] as const;

export const WritingGoalScopeSchema = z.enum(WRITING_GOAL_SCOPES);

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * Daily word target bounds.
 *
 * A goal of `0` means "no active goal" and is rejected on write (clear the goal
 * instead). The upper bound is generous but finite so a corrupt value cannot be
 * persisted.
 */
export const MIN_DAILY_WORD_TARGET = 1;
export const MAX_DAILY_WORD_TARGET = 1_000_000;

export const WritingGoalSchema = z
  .object({
    /** Primary key. The workspace-wide goal uses `GLOBAL_WRITING_GOAL_ID`. */
    id: z.string().min(1, 'Goal id is required'),
    /** Scope discriminator (today always `'global'`). */
    scope: WritingGoalScopeSchema,
    /** Target words per day. Positive integer; `0` is not a valid goal. */
    dailyWordTarget: z
      .number()
      .int('Daily target must be an integer')
      .min(MIN_DAILY_WORD_TARGET, `Daily target must be at least ${MIN_DAILY_WORD_TARGET}`)
      .max(MAX_DAILY_WORD_TARGET, `Daily target must be at most ${MAX_DAILY_WORD_TARGET}`),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((goal) => goal.updatedAt >= goal.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** A persisted writing goal. */
export type WritingGoal = z.infer<typeof WritingGoalSchema>;
/** Scope of a writing goal. */
export type WritingGoalScope = z.infer<typeof WritingGoalScopeSchema>;
