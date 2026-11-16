/**
 * Local writing-style analysis (Round 1 — AI Toolbox: Style Analyzer).
 *
 * PURE, deterministic text metrics computed on the client — no AI call, no
 * network. These give the author an objective, honest read on their prose
 * (sentence rhythm, lexical variety, readability, adverbs, passive hints) that
 * complements the optional AI critique. Every number is derived only from the
 * supplied text; empty input yields zeros / `null`, never an invented score.
 *
 * Readability uses the Flesch Reading Ease and Flesch–Kincaid grade formulas.
 * Syllable counting is a heuristic (vowel-group based) appropriate for English;
 * the function is documented as such and does not over-claim accuracy.
 */

export interface StyleMetrics {
  /** Words (whitespace-delimited tokens containing at least one letter/digit). */
  wordCount: number;
  /** Sentences (split on ., !, ?, …, allowing repeated terminators). */
  sentenceCount: number;
  characters: number;
  /** Average words per sentence (0 when no sentences). */
  avgSentenceLength: number;
  /** Standard deviation of sentence length in words (rhythm/variety). */
  sentenceLengthStdDev: number;
  /** Longest sentence in words. */
  longestSentenceWords: number;
  /** Distinct lowercased words / total words (0..1). */
  lexicalDiversity: number;
  /** Words with >= 3 syllables / total words (0..1). */
  longWordRatio: number;
  /** Adverbs ending in -ly / total words (0..1). */
  adverbRatio: number;
  /** Rough passive-voice hint count ("was/were/be + past-ish word + by"). */
  passiveHints: number;
  /** Flesch Reading Ease (higher = easier). `null` when not computable. */
  fleschReadingEase: number | null;
  /** Flesch–Kincaid grade level. `null` when not computable. */
  fleschKincaidGrade: number | null;
  /** Average syllables per word (0 when no words). */
  avgSyllablesPerWord: number;
  /** Short qualitative band for the readability score. */
  readabilityBand: 'very easy' | 'easy' | 'fairly easy' | 'standard' | 'fairly difficult' | 'difficult' | 'very difficult' | 'n/a';
}

const SENTENCE_SPLIT = /[.!?…]+["'”’)\]]?\s+/;
const WORD_SPLIT = /\s+/;
const WORD_PATTERN = /[A-Za-z0-9\u00C0-\u024F]/;
const ADVERB_SUFFIX = /ly$/i;

/** Counts syllables in an English word using a vowel-group heuristic. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  // Collapse vowel groups and drop a silent trailing 'e'.
  const groups = w.replace(/[^aeiouy]+/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  let syllables = groups;
  if (w.endsWith('e') && !w.endsWith('le') && syllables > 1) syllables -= 1;
  return Math.max(1, syllables);
}

/** Splits text into non-empty sentences (trailing fragment counts as one). */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && WORD_PATTERN.test(s));
}

/** Splits text into words (tokens that contain at least one alphanumeric). */
export function splitWords(text: string): string[] {
  return text
    .split(WORD_SPLIT)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && WORD_PATTERN.test(w));
}

/** Estimates passive-voice usage with a conservative regex. */
function countPassiveHints(text: string): number {
  const matches = text.match(/\b(is|are|was|were|be|been|being)\b\s+\w+(ed|en)\b/gi);
  return matches ? matches.length : 0;
}

/** Computes the full set of style metrics for a block of text. */
export function analyzeStyle(text: string): StyleMetrics {
  const words = splitWords(text);
  const sentences = splitSentences(text);
  const wordCount = words.length;
  const sentenceCount = sentences.length;

  const lengths = sentences.map((s) => splitWords(s).length).filter((n) => n > 0);
  const avgSentenceLength = lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const variance =
    lengths.length > 0
      ? lengths.reduce((sum, len) => sum + (len - avgSentenceLength) ** 2, 0) / lengths.length
      : 0;

  const lower = words.map((w) => w.toLowerCase());
  const distinct = new Set(lower).size;
  const lexicalDiversity = wordCount > 0 ? distinct / wordCount : 0;

  let syllableTotal = 0;
  let longWords = 0;
  let adverbs = 0;
  for (const word of words) {
    const syl = countSyllables(word);
    syllableTotal += syl;
    if (syl >= 3) longWords += 1;
    if (ADVERB_SUFFIX.test(word) && word.length > 3) adverbs += 1;
  }

  const avgSyllablesPerWord = wordCount > 0 ? syllableTotal / wordCount : 0;

  let fleschReadingEase: number | null = null;
  let fleschKincaidGrade: number | null = null;
  if (wordCount > 0 && sentenceCount > 0) {
    const asl = wordCount / sentenceCount;
    const asw = syllableTotal / wordCount;
    fleschReadingEase = round2(206.835 - 1.015 * asl - 84.6 * asw);
    fleschKincaidGrade = round2(0.39 * asl + 11.8 * asw - 15.59);
  }

  return {
    wordCount,
    sentenceCount,
    characters: text.length,
    avgSentenceLength: round2(avgSentenceLength),
    sentenceLengthStdDev: round2(Math.sqrt(variance)),
    longestSentenceWords: lengths.length > 0 ? Math.max(...lengths) : 0,
    lexicalDiversity: round2(lexicalDiversity),
    longWordRatio: wordCount > 0 ? round2(longWords / wordCount) : 0,
    adverbRatio: wordCount > 0 ? round2(adverbs / wordCount) : 0,
    passiveHints: countPassiveHints(text),
    fleschReadingEase,
    fleschKincaidGrade,
    avgSyllablesPerWord: round2(avgSyllablesPerWord),
    readabilityBand: bandFor(fleschReadingEase),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function bandFor(score: number | null): StyleMetrics['readabilityBand'] {
  if (score === null) return 'n/a';
  if (score >= 90) return 'very easy';
  if (score >= 80) return 'easy';
  if (score >= 70) return 'fairly easy';
  if (score >= 60) return 'standard';
  if (score >= 50) return 'fairly difficult';
  if (score >= 30) return 'difficult';
  return 'very difficult';
}

/** The most frequently used (non-trivial) words, for an at-a-glance summary. */
export function topWords(text: string, limit = 8): Array<{ word: string; count: number }> {
  const STOP = new Set([
    'the', 'and', 'a', 'an', 'to', 'of', 'in', 'i', 'it', 'is', 'that', 'was', 'he', 'she', 'his',
    'her', 'as', 'with', 'for', 'on', 'at', 'but', 'had', 'not', 'be', 'you', 'they', 'we', 'her',
  ]);
  const counts = new Map<string, number>();
  for (const word of splitWords(text)) {
    const w = word.toLowerCase().replace(/[^a-z']/g, '');
    if (w.length < 4 || STOP.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([word, count]) => ({ word, count }));
}
