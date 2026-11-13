/**
 * Token ESTIMATION for context budgeting (P6).
 *
 * This is an honest approximation, NOT a real tokenizer. Running each provider's
 * BPE vocabulary in the browser would be large and version-fragile, so we use a
 * well-documented rule of thumb and label every number in the UI as an estimate.
 *
 * Why a hybrid rule:
 *   - Latin text averages ~4 characters per token.
 *   - CJK text averages closer to ~1–1.5 characters per token, so a pure /4 rule
 *     would dangerously UNDER-count it and blow the real model context.
 * We therefore count CJK-ish characters at a heavier weight and the rest by the
 * character heuristic, taking the larger of the two estimates per segment.
 *
 * The estimator is deliberately DETERMINISTIC (no randomness, no locale), so the
 * preview a user sees equals the budget the assembler enforces (R5).
 */

/** Characters per token for non-CJK text. */
export const CHARS_PER_TOKEN = 4;

/** Rough tokens per CJK character (kept conservative/high to avoid overflow). */
export const CJK_CHARS_PER_TOKEN = 1.4;

/**
 * Unicode ranges that are token-dense. Kept as a single regex to avoid a large
 * per-character table; covers CJK Unified, Hiragana, Katakana, Hangul, and the
 * common CJK punctuation/fullwidth block.
 */
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/g;

/**
 * Estimates the token count of `text`.
 *
 * @returns a non-negative integer estimate (ceil of the weighted sum).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  // Reset stateful global regex before use.
  CJK_PATTERN.lastIndex = 0;
  while (CJK_PATTERN.exec(text) !== null) {
    cjk += 1;
  }

  const cjkTokens = cjk / CJK_CHARS_PER_TOKEN;
  const remainingChars = text.length - cjk;
  const latinTokens = remainingChars / CHARS_PER_TOKEN;

  // A small fixed overhead accounts for message framing (role markers, BOS/EOS).
  const framing = 4;
  return Math.max(0, Math.ceil(cjkTokens + latinTokens + framing));
}

/**
 * Estimates tokens for a list of message bodies together with their per-message
 * role overhead, matching how chat APIs count the whole conversation.
 */
export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  // Each message has a few tokens of structural overhead beyond its content.
  const PER_MESSAGE_OVERHEAD = 4;
  return messages.reduce((total, message) => total + estimateTokens(message.content) + PER_MESSAGE_OVERHEAD, 0);
}
