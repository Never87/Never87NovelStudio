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
