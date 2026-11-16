/**
 * Time helpers.
 *
 * Rule: persisted models ALWAYS store Unix epoch milliseconds as `number`.
 * Human-readable strings such as "2 hours ago" are produced only at render
 * time by `formatRelative` and are never written back into a model.
 */

/** Current time as Unix epoch milliseconds. */
export function now(): number {
  return Date.now();
}

/** True when `value` is a usable, finite, non-negative timestamp. */
export function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Formats a timestamp as a short relative time for UI display.
 *
 * Invalid timestamps yield an empty string so the UI can simply render
 * nothing instead of "Invalid Date" / "NaN".
 *
 * @param timestamp Unix epoch milliseconds.
 * @param reference Comparison instant (defaults to now) — injectable for tests.
 */
export function formatRelative(timestamp: number, reference: number = now()): string {
  if (!isValidTimestamp(timestamp) || !isValidTimestamp(reference)) return '';

  const delta = reference - timestamp;
  // Future timestamps (clock skew, imported data) collapse to "just now".
  if (delta < MINUTE) return 'just now';

  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  }
  if (delta < WEEK) {
    const days = Math.floor(delta / DAY);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  if (delta < MONTH) {
    const weeks = Math.floor(delta / WEEK);
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  }
  if (delta < YEAR) {
    const months = Math.floor(delta / MONTH);
    return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  }
  const years = Math.floor(delta / YEAR);
  return `${years} ${years === 1 ? 'year' : 'years'} ago`;
}

/** Pad a number to two digits (e.g. 5 -> "05"). */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Formats a timestamp as a LOCAL calendar-day key (`YYYY-MM-DD`).
 *
 * "Local" is deliberate: a writer's "today" is their wall-clock day, not a UTC
 * day. `Date#getFullYear/getMonth/getDate` already return local values, so the
 * key matches what the user considers "today". The ISO-ordered shape means
 * lexicographic comparison equals chronological comparison, which is what the
 * writing-activity rollup relies on.
 *
 * @param timestamp Unix epoch milliseconds (defaults to now).
 */
export function localDateKey(timestamp: number = now()): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  return `${year}-${month}-${day}`;
}

/**
 * Returns the local date key `daysAgo` days before `reference` (0 = today).
 *
 * Built with the local-time `Date` setters (not millisecond subtraction) so it
 * stays correct across DST transitions and month/year boundaries.
 *
 * @param daysAgo Whole days to step back (>= 0).
 * @param reference Base instant (defaults to now).
 */
export function localDateKeyDaysAgo(daysAgo: number, reference: number = now()): string {
  const date = new Date(reference);
  date.setDate(date.getDate() - Math.max(0, Math.trunc(daysAgo)));
  return localDateKey(date.getTime());
}

