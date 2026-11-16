import type { ChapterStatus } from '@/types';
import type { WritingActivity } from '@/schemas/writing-activity';
import { localDateKeyDaysAgo } from '@/utils/date';

/**
 * Pure, testable dashboard statistics helpers (Dashboard fix — Round 1).
 *
 * These functions contain NO database access and NO React — they take plain
 * data (already fetched by `WritingStatsService`) and return plain results. This
 * keeps the non-trivial logic (streak maths, weekly bucketing, "completed"
 * definition) unit-testable in isolation and impossible to drift from the UI.
 */

/**
 * Statuses that count as a COMPLETED chapter.
 *
 * A chapter's lifecycle is `planned → drafting → drafted → revised → final`
 * (see `schemas/outline.ts`). "Completed" means the chapter has been REVISED or
 * FINALISED — i.e. it is past plain drafting. We deliberately do NOT count
 * `planned`/`drafting`/`drafted`, so creating chapters alone never inflates the
 * "completed" count (the original demo data did exactly that, wrongly).
 *
 * This single constant is the one place the definition lives so every surface
 * (Dashboard, future Statistics page) agrees.
 */
export const COMPLETED_CHAPTER_STATUSES: readonly ChapterStatus[] = ['revised', 'final'];

/** True when a chapter status counts as completed. */
export function isCompletedChapter(status: ChapterStatus): boolean {
  return COMPLETED_CHAPTER_STATUSES.includes(status);
}

/** A single day's workspace-wide word output, for the chart. */
export interface DailyOutput {
  /** Local calendar-day key (`YYYY-MM-DD`). */
  dateKey: string;
  /** Short weekday label (e.g. "Mon"), for the chart's x-axis. */
  label: string;
  /** Total words written that day across all projects (>= 0). */
  words: number;
}

/**
 * Sums activity rows into a map of `dateKey → total words` across all projects.
 * Rows with the same day (different projects) are added together.
 */
export function aggregateWordsByDay(rows: readonly WritingActivity[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.dateKey, (totals.get(row.dateKey) ?? 0) + row.wordsWritten);
  }
  return totals;
}

/**
 * Builds the last `days` days of daily output ending at `reference` (today),
 * oldest first — exactly what the 7-day chart renders. Days with no activity
 * are included with `words: 0` (an honest zero, not a gap).
 *
 * @param rows Activity rows within the window (any projects).
 * @param days Number of days to include (e.g. 7).
 * @param reference The "today" instant (injectable for tests).
 */
export function buildDailyOutputSeries(
  rows: readonly WritingActivity[],
  days: number,
  reference: number = Date.now(),
): DailyOutput[] {
  const totals = aggregateWordsByDay(rows);
  const span = Math.max(0, Math.trunc(days));
  const series: DailyOutput[] = [];
  for (let i = span - 1; i >= 0; i -= 1) {
    const dateKey = localDateKeyDaysAgo(i, reference);
    // Weekday label from the local date at noon to avoid any DST edge.
    const weekday = new Date(`${dateKey}T12:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
    });
    series.push({ dateKey, label: weekday, words: totals.get(dateKey) ?? 0 });
  }
  return series;
}

/**
 * Computes the current writing streak, in consecutive days.
 *
 * A streak counts backwards from TODAY (or, if nothing was written today yet,
 * from YESTERDAY — so a streak is not broken merely because the user has not
 * written *yet today*). It stops at the first day with zero output. Because the
 * activity ledger starts empty on upgrade, an empty ledger yields a streak of 0
 * — we never fabricate a historical streak.
 *
 * @param totalByDay Map of `dateKey → words` across all projects.
 * @param reference The "now" instant (injectable for tests).
 */
export function computeStreak(totalByDay: Map<string, number>, reference: number = Date.now()): number {
  // If today has output, start at today; otherwise start yesterday so a 12-day
  // streak isn't shown as 0 at 00:05 before the user has written.
  const todayKey = localDateKeyDaysAgo(0, reference);
  const startOffset = (totalByDay.get(todayKey) ?? 0) > 0 ? 0 : 1;

  let streak = 0;
  for (let offset = startOffset; ; offset += 1) {
    const key = localDateKeyDaysAgo(offset, reference);
    if ((totalByDay.get(key) ?? 0) > 0) {
      streak += 1;
    } else {
      break;
    }
    // Hard stop: no streak can exceed the days since the epoch; this also
    // guards runaway loops on pathological input.
    if (streak > 100_000) break;
  }
  return streak;
}

/**
 * The best (longest) streak in the provided activity history.
 *
 * Used for the honest "best streak" line. An empty history yields 0.
 */
export function computeBestStreak(rows: readonly WritingActivity[]): number {
  const dayKeys = [...new Set(rows.filter((r) => r.wordsWritten > 0).map((r) => r.dateKey))].sort();
  let best = 0;
  let current = 0;
  let previous: string | null = null;
  for (const key of dayKeys) {
    if (previous !== null && isNextDay(previous, key)) {
      current += 1;
    } else {
      current = 1;
    }
    if (current > best) best = current;
    previous = key;
  }
  return best;
}

/** True when `next` is the calendar day immediately after `prev` (both YYYY-MM-DD). */
function isNextDay(prev: string, next: string): boolean {
  const prevTime = new Date(`${prev}T00:00:00`).getTime();
  const nextTime = new Date(`${next}T00:00:00`).getTime();
  if (!Number.isFinite(prevTime) || !Number.isFinite(nextTime)) return false;
  return nextTime - prevTime === 24 * 60 * 60 * 1000;
}

/**
 * Incrementally updates a running daily total with a NET word delta, clamping
 * at zero. A net-negative edit (deletion) reduces the day's output but never
 * drives it below 0 — we never record "negative words written".
 */
export function applyWordDelta(currentTotal: number, delta: number): number {
  return Math.max(0, currentTotal + delta);
}
