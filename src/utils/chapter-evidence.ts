/**
 * Evidence grounding for chapter analysis (P11 integration).
 *
 * The AI analysis pass proposes entities/relationships together with QUOTES
 * (short verbatim passages) from the chapter prose. This module is the SINGLE
 * place that turns a quote into a validated, offset-bearing `AnalysisEvidence`
 * whose offsets are GUARANTEED to address the exact persisted source text.
 *
 * Why a dedicated module (rather than reusing the document P8 resolver):
 *   - P8 resolves quotes against an imported `SourceDocument`'s confirmed
 *     `DocumentSection`s. A P11 chapter has NO sections — its source is the
 *     single persisted chapter draft `content`.
 *   - The invariant is nonetheless identical (and deliberately so): a resolved
 *     evidence's `[start, end)` slice into the source must reproduce the quote
 *     VERBATIM (UTF-16 code units, never normalised).
 *
 * The functions are pure + synchronous so they are trivially unit-testable and
 * never touch a transaction.
 */

import { findOccurrences } from './evidence-resolution';

/** The reason a quote could not be grounded against the source prose. */
export type ChapterEvidenceFailure =
  | 'empty-quote'
  | 'not-found'
  | 'ambiguous'
  | 'offset-mismatch'
  | 'out-of-bounds';

/** A grounded evidence span (offsets are into the chapter's `content`). */
export interface GroundedChapterEvidence {
  /** The verbatim quote, preserved exactly as validated. */
  quote: string;
  /** UTF-16 start offset into the chapter `content`, inclusive. */
  start: number;
  /** UTF-16 end offset into the chapter `content`, exclusive. */
  end: number;
}

export type GroundChapterEvidenceResult =
  | { ok: true; evidence: GroundedChapterEvidence }
  | { ok: false; reason: ChapterEvidenceFailure; detail: string };

export interface GroundChapterEvidenceOptions {
  /**
   * Optional character offset into the prose where the quote is expected to
   * begin. When supplied it disambiguates repeated quotes (the nearest match
   * wins). When omitted, a quote occurring more than `ambiguityLimit` times is
   * rejected as ambiguous rather than guessed.
   */
  expectedStart?: number;
  /** How many identical occurrences are tolerated without a hint. Default 1. */
  ambiguityLimit?: number;
}

/** Minimum run of identical occurrences after which a bare quote is "ambiguous". */
const DEFAULT_AMBIGUITY_LIMIT = 1;

/**
 * Grounds a quote against the chapter prose, computing exact UTF-16 offsets.
 *
 * The quote must appear verbatim in `prose`. When it appears multiple times:
 *   - with `expectedStart`, the occurrence nearest the hint wins (ties -> earliest);
 *   - without a hint, more than `ambiguityLimit` occurrences is rejected.
 *
 * Returns the offsets ONLY when the slice `prose.slice(start, end)` reproduces
 * the quote exactly - never fabricates a location.
 */
export function groundChapterEvidence(
  prose: string,
  quote: string,
  options: GroundChapterEvidenceOptions = {},
): GroundChapterEvidenceResult {
  if (quote.length === 0) {
    return { ok: false, reason: 'empty-quote', detail: 'Evidence quote is empty.' };
  }

  const positions = findOccurrences(prose, quote);
  if (positions.length === 0) {
    return { ok: false, reason: 'not-found', detail: 'Quote was not found verbatim in the chapter prose.' };
  }

  let start: number;
  if (options.expectedStart !== undefined) {
    start = positions.reduce(
      (best, current) =>
        Math.abs(current - options.expectedStart!) < Math.abs(best - options.expectedStart!) ? current : best,
      positions[0],
    );
  } else {
    const limit = options.ambiguityLimit ?? DEFAULT_AMBIGUITY_LIMIT;
    if (positions.length > limit) {
      return {
        ok: false,
        reason: 'ambiguous',
        detail: `Quote occurs ${positions.length} times in the chapter and no disambiguating position was supplied.`,
      };
    }
    start = positions[0];
  }

  const end = start + quote.length;
  if (end > prose.length || end < start) {
    return { ok: false, reason: 'out-of-bounds', detail: `Resolved range [${start}, ${end}) falls outside the prose.` };
  }
  // Belt-and-braces: the slice must be exactly the quote (verbatim).
  if (prose.slice(start, end) !== quote) {
    return {
      ok: false,
      reason: 'offset-mismatch',
      detail: `Resolved offsets [${start}, ${end}) do not reproduce the quote.`,
    };
  }

  return { ok: true, evidence: { quote, start, end } };
}

/**
 * Grounds a list of quotes, returning only the ones that resolve. Never throws;
 * unsupported quotes are dropped (the caller decides whether zero survivors
 * makes the whole candidate "unsupported").
 */
export function groundChapterQuotes(prose: string, quotes: readonly string[]): GroundedChapterEvidence[] {
  const out: GroundedChapterEvidence[] = [];
  for (const quote of quotes) {
    if (typeof quote !== 'string') continue;
    if (quote.trim().length === 0) continue;
    const result = groundChapterEvidence(prose, quote);
    if (result.ok) out.push(result.evidence);
  }
  return out;
}

/** True when an evidence span still addresses the exact text in `prose`. */
export function chapterEvidenceValid(prose: string, evidence: { start: number; end: number; quote: string }): boolean {
  if (!Number.isInteger(evidence.start) || !Number.isInteger(evidence.end)) return false;
  if (evidence.start < 0 || evidence.end < evidence.start || evidence.end > prose.length) return false;
  return prose.slice(evidence.start, evidence.end) === evidence.quote;
}
