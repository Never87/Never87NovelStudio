/**
 * Filename & display-name sanitisation (P9 Batch A).
 *
 * Reusable, deterministic helpers shared by every publishing writer. They are
 * pure (no filesystem, no browser), preserve Unicode (Chinese etc.), and never
 * split a surrogate pair when truncating.
 *
 * The rules here encode ONLY filesystem-safety concerns — no platform-specific
 * naming policy. Any publishing naming preference belongs in the preset's
 * `fileNameTemplate`/`fileExtension`, which this utility applies generically.
 */

/**
 * Control characters (C0 + DEL) are REMOVED entirely — a filename never
 * benefits from them and turning them into spaces would create spurious gaps.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Path/illegal characters are REPLACED with a space (preserves word breaks). */
const ILLEGAL_CHARS = /[<>:"/\\|?*]/g;

/**
 * Reserved device names on Windows (case-insensitive, extension-insensitive).
 * Producing one of these verbatim would create an unopenable file, so we
 * suffix them (see `sanitizeFileName`).
 */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Documented default maximum length for the base (pre-extension) name. */
export const MAX_FILE_NAME_LENGTH = 120;

/** Documented fallback when a name sanitises to nothing. */
export const FALLBACK_FILE_NAME = 'manuscript';

/**
 * Truncates a string to at most `max` UTF-16 units WITHOUT splitting a
 * surrogate pair. If the cut would fall between a high and low surrogate, the
 * high surrogate is dropped so the last kept code point stays intact.
 */
export function truncateUnicode(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastCode = cut.charCodeAt(cut.length - 1);
  // High surrogate (0xD800–0xDBFF) with its pair cut off → drop it.
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
    return cut.slice(0, -1);
  }
  return cut;
}

/**
 * Sanitises an arbitrary string into a safe file-name BASE (no extension).
 *
 *  - Removes filesystem-reserved and control characters.
 *  - Collapses runs of whitespace to single spaces and trims.
 *  - Preserves Unicode letters (e.g. Chinese) verbatim.
 *  - Strips leading dots (no hidden files) and trailing dots/spaces (Windows).
 *  - Guards Windows reserved device names by suffixing `_`.
 *  - Truncates to `maxLength` WITHOUT splitting a surrogate pair.
 *  - Returns `FALLBACK_FILE_NAME` when the result would be empty.
 */
export function sanitizeFileName(input: string, maxLength: number = MAX_FILE_NAME_LENGTH): string {
  let cleaned = (input ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // No leading dots (hidden), no trailing dots/spaces (invalid on Windows).
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim();

  if (cleaned.length === 0) return FALLBACK_FILE_NAME;

  cleaned = truncateUnicode(cleaned, maxLength);
  // Truncation can re-expose trailing dots/spaces; strip them again.
  cleaned = cleaned.replace(/[. ]+$/, '').trim();
  if (cleaned.length === 0) return FALLBACK_FILE_NAME;

  if (RESERVED_NAMES.has(cleaned.toLowerCase())) {
    cleaned = `${cleaned}_`;
  }
  return cleaned;
}

/** Normalises an extension to a bare lowercase tag (no leading dot). */
function normaliseExtension(extension: string): string {
  return (extension ?? '').replace(/^\.+/, '').trim().toLowerCase();
}

/**
 * Builds a full file name from a base and an extension.
 *
 * - The extension is normalised (no leading dot, lowercase) and applied
 *   consistently.
 * - A base that already ends in the same extension does NOT get a duplicate
 *   extension.
 * - An empty extension returns the sanitised base with no trailing dot.
 */
export function buildFileName(
  base: string,
  extension: string,
  maxLength: number = MAX_FILE_NAME_LENGTH,
): string {
  const ext = normaliseExtension(extension);
  let name = sanitizeFileName(base, maxLength);

  if (ext.length === 0) return name;

  // Avoid duplicating an extension the base already carries.
  const suffix = `.${ext}`;
  if (name.toLowerCase().endsWith(suffix)) {
    return name;
  }
  // Reserve room for the suffix so the TOTAL stays bounded and never splits a
  // surrogate pair of the base.
  const baseBudget = Math.max(1, maxLength - suffix.length);
  name = truncateUnicode(sanitizeFileName(base, baseBudget), baseBudget);
  return `${name}${suffix}`;
}

/**
 * Fills a file-name template's placeholders and returns a safe file name with
 * the given extension.
 *
 * Supported placeholders: `{title}`, `{author}`. Any leftover `{...}` tokens
 * are left untouched (so a custom template's unknown token surfaces rather than
 * vanishing). The result is ALWAYS run through `buildFileName`, so the caller
 * never needs to sanitise separately.
 */
export function buildFileNameFromTemplate(
  template: string,
  values: { title: string; author: string },
  extension: string,
  maxLength: number = MAX_FILE_NAME_LENGTH,
): string {
  const filled = (template ?? '')
    .replace(/\{title\}/g, values.title ?? '')
    .replace(/\{author\}/g, values.author ?? '');
  return buildFileName(filled, extension, maxLength);
}
