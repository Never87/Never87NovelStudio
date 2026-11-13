/**
 * Evidence resolution for extraction (P8 Batch 3).
 *
 * Turns a model/user-supplied QUOTE (plus optional position hints) into a
 * validated `DocumentEvidence` whose offsets are guaranteed to address the
 * exact text in the stored document. This is the single place that maps
 * "section-relative" offsets to "document-relative" UTF-16 offsets and enforces
 * the invariants the rest of the pipeline relies on:
 *
 *   - `quote` is preserved EXACTLY (never normalised) — offsets are computed
 *     against the verbatim source, so `\r\n`, a BOM, CJK and emoji are all
 *     counted exactly as the JS engine counts UTF-16 code units.
 *   - A resolved evidence points INTO A SINGLE confirmed section:
 *     `document.rawText.slice(section.start + start, section.start + end)` must
 *     equal `section.text.slice(start, end)` and the supplied quote.
 *   - Ambiguous matches (the quote appears more than once with no disambiguating
 *     context) are REJECTED, never guessed — we would rather drop a candidate
 *     than fabricate a location.
 *
 * The functions are pure and synchronous (they only read already-loaded text),
 * so they are easy to unit-test and never touch a transaction.
 */

import type { DocumentSection } from '@/types';
import type { DocumentEvidence } from '@/schemas/document';

/** Minimum run of identical occurrences after which a bare quote is "ambiguous". */
const DEFAULT_AMBIGUITY_LIMIT = 1;

/** Reason a resolution attempt failed — surfaced with a stable code for tests/UI. */
export type EvidenceResolutionFailure =
  | 'empty-quote'
  | 'not-found'
  | 'ambiguous'
  | 'cross-section'
  | 'offset-mismatch'
  | 'out-of-bounds';

export interface ResolveEvidenceOptions {
  /**
   * Optional section-relative character offset where the quote is expected to
   * begin. When supplied it is used to DISAMBIGUATE repeated quotes (the match
   * nearest the hint wins). When omitted, a quote that occurs more than
   * `ambiguityLimit` times is rejected as ambiguous.
   */
  expectedStart?: number;
  /**
   * How many identical matches are tolerated before the match is considered
   * ambiguous when no `expectedStart` is given. Defaults to 1 (a second identical
   * occurrence makes a bare quote ambiguous). Raise only if the caller has other
   * disambiguating context.
   */
  ambiguityLimit?: number;
}

export type ResolveEvidenceResult =
  | { ok: true; evidence: DocumentEvidence }
  | { ok: false; reason: EvidenceResolutionFailure; detail: string };

/**
 * Finds every section-relative index where `quote` occurs verbatim inside
 * `text`. Uses `indexOf` in a loop so overlapping matches are NOT counted twice
 * but every non-overlapping position is (matching how a reader would count).
 */
export function findOccurrences(text: string, quote: string): number[] {
  const positions: number[] = [];
  if (quote.length === 0) return positions;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(quote, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + quote.length; // non-overlapping occurrences
  }
  return positions;
}

/**
 * Resolves a quote to a section-relative `DocumentEvidence` for ONE section.
 *
 * The quote must appear verbatim in `section.text`. When it appears multiple
 * times:
 *   - with `expectedStart`, the occurrence closest to the hint wins (ties → the
 *     earliest), which is how the AI path disambiguates using a hint it supplies;
 *   - without a hint, more than `ambiguityLimit` occurrences is rejected as
 *     `ambiguous`.
 *
 * Returns offsets relative to the SECTION; callers convert to document offsets
 * (or use `resolveEvidenceInDocument`).
 */
export function resolveEvidenceInSection(
  section: DocumentSection,
  quote: string,
  options: ResolveEvidenceOptions = {},
): ResolveEvidenceResult {
  if (quote.length === 0) {
    return { ok: false, reason: 'empty-quote', detail: 'Evidence quote is empty.' };
  }

  const positions = findOccurrences(section.text, quote);
  if (positions.length === 0) {
    return {
      ok: false,
      reason: 'not-found',
      detail: `Quote not found verbatim in section "${section.id}".`,
    };
  }

  let start: number;
  if (options.expectedStart !== undefined) {
    // Pick the occurrence whose start is nearest the hint.
    start = positions.reduce((best, current) =>
      Math.abs(current - options.expectedStart!) < Math.abs(best - options.expectedStart!) ? current : best,
    positions[0]);
  } else {
    const limit = options.ambiguityLimit ?? DEFAULT_AMBIGUITY_LIMIT;
    if (positions.length > limit) {
      return {
        ok: false,
        reason: 'ambiguous',
        detail:
          `Quote occurs ${positions.length} times in section "${section.id}" and no disambiguating ` +
          'position was supplied.',
      };
    }
    start = positions[0];
  }

  const end = start + quote.length;
  // Belt-and-braces: the slice must be exactly the quote (verbatim, no normalise).
  if (section.text.slice(start, end) !== quote) {
    return {
      ok: false,
      reason: 'offset-mismatch',
      detail: `Resolved offsets [${start}, ${end}) do not reproduce the quote in section "${section.id}".`,
    };
  }

  return {
    ok: true,
    evidence: {
      documentId: section.documentId,
      sectionId: section.id,
      start,
      end,
      quote,
    },
  };
}

/**
 * Resolves a quote against a document's rawText THROUGH a specific section,
 * producing a `DocumentEvidence` and VERIFYING the document-relative slice.
 *
 * This is the authoritative check used before persistence: it recomputes the
 * document-relative range `[section.start + start, section.start + end)` and
 * asserts `rawText.slice(...) === quote`. If the section's stored text drifted
 * from the rawText (which Batch 2 prevents, but we never trust blindly) the
 * resolution is rejected as `cross-section`/`offset-mismatch`.
 *
 * The quote must lie entirely within the section (it is matched against
 * `section.text`, so it cannot span sections); a quote that exists in the raw
 * text but only ACROSS a section boundary is intentionally unsupported.
 */
export function resolveEvidenceInDocument(
  rawText: string,
  section: DocumentSection,
  quote: string,
  options: ResolveEvidenceOptions = {},
): ResolveEvidenceResult {
  // The section itself must be a faithful slice of the rawText.
  if (rawText.slice(section.start, section.end) !== section.text) {
    return {
      ok: false,
      reason: 'cross-section',
      detail: `Section "${section.id}" text is not a faithful slice of the document raw text.`,
    };
  }

  const inSection = resolveEvidenceInSection(section, quote, options);
  if (!inSection.ok) return inSection;

  const { start, end } = inSection.evidence;
  const docStart = section.start + start;
  const docEnd = section.start + end;

  if (docStart < section.start || docEnd > section.end || docEnd < docStart) {
    return { ok: false, reason: 'out-of-bounds', detail: `Resolved range falls outside section "${section.id}".` };
  }
  if (rawText.slice(docStart, docEnd) !== quote) {
    return {
      ok: false,
      reason: 'offset-mismatch',
      detail: `Document slice [${docStart}, ${docEnd}) does not reproduce the quote.`,
    };
  }

  return {
    ok: true,
    evidence: {
      documentId: section.documentId,
      sectionId: section.id,
      start,
      end,
      quote,
    },
  };
}

/**
 * Converts a (already validated) section-relative evidence range to absolute
 * document-relative UTF-16 offsets. Pure; throws on an out-of-range request so
 * a caller cannot silently store a misaligned locator.
 */
export function toDocumentOffsets(section: DocumentSection, start: number, end: number): { start: number; end: number } {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > section.text.length) {
    throw new RangeError(`Evidence range [${start}, ${end}) is invalid for section "${section.id}".`);
  }
  return { start: section.start + start, end: section.start + end };
}
