import { z } from 'zod';

/**
 * Writing activity schema (Dashboard fix — Round 1).
 *
 * ## Why this exists
 *
 * The Dashboard's Words Written / Writing Streak / Writing Goal progress must be
 * computed from REAL writing, not demo data. The pre-existing manuscript model
 * stores only the CURRENT prose of each draft (`chapterDrafts` / `sceneDrafts`)
 * and an optional, sparse version-snapshot log — neither can reliably
 * reconstruct how many words were written on a given past day. Fabricating that
 * history would be dishonest, so instead we record a small, real, append-mostly
 * activity ledger **from the moment this ships forward**.
 *
 * ## Shape
 *
 * One row per `(projectId, dateKey)`, where `dateKey` is a LOCAL calendar day
 * (`YYYY-MM-DD`). `wordsWritten` accumulates the NET positive change in a
 * project's manuscript word count during that day (deletions reduce it, but the
 * stored value is clamped at >= 0 so a net-negative editing day never shows a
 * negative "words written"). This single table powers:
 *   - workspace daily/weekly output (SUM over projects for a dateKey),
 *   - the writing streak (consecutive dateKeys with output > 0),
 *   - the 7-day goal chart.
 *
 * It is intentionally NOT a per-keystroke audit log (that belongs to
 * `draftVersions`); it is a compact, durable rollup that survives reloads.
 *
 * ## Reliability contract
 *
 * - A brand-new project / brand-new day simply has no row → treated as 0 output
 *   (honest empty state), never an invented value.
 * - The rollup is written on the SAME save path that persists prose (see
 *   `ManuscriptService.saveChapterDraft`), inside the normal write flow, so it
 *   can never drift from what was actually saved.
 */

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

export const WritingActivitySchema = z
  .object({
    /** Primary key, prefixed (`act_...`). */
    id: z.string().min(1, 'Activity id is required'),
    /** Owning project — every row is scoped to a project. */
    projectId: z.string().min(1, 'Activity projectId is required'),
    /**
     * LOCAL calendar day the output belongs to, formatted `YYYY-MM-DD`.
     * Stored as a string so it can be indexed and compared lexicographically
     * (which for ISO dates is also chronological).
     */
    dateKey: z.string().regex(DATE_KEY_PATTERN, 'dateKey must be YYYY-MM-DD'),
    /**
     * Net words written for this project on this day. Non-negative integer;
     * a net-negative editing day clamps to 0 (we never record "negative words").
     */
    wordsWritten: z
      .number()
      .int('wordsWritten must be an integer')
      .nonnegative('wordsWritten must be non-negative'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((row) => row.updatedAt >= row.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** A persisted per-project, per-day writing-activity rollup row. */
export type WritingActivity = z.infer<typeof WritingActivitySchema>;
