/**
 * Lightweight word-level diff for AI result previews (P5).
 *
 * The AI Assistance flow must let the user compare original vs generated text
 * BEFORE applying. A full diff library would be a heavy dependency for a
 * feature that only needs to highlight changed words, so this implements a
 * deterministic LCS-based word diff. It is presentation-only: it never mutates
 * or decides what gets applied.
 */

export type DiffOp = 'equal' | 'insert' | 'delete';

export interface DiffToken {
  op: DiffOp;
  /** The word plus its trailing whitespace, preserved verbatim. */
  text: string;
}

/**
 * Splits text into word-ish tokens that keep their trailing whitespace, so
 * re-joining tokens reproduces the original string exactly (required for a
 * faithful "apply" of the generated side).
 */
export function tokenizeWords(text: string): string[] {
  // Split before each word boundary run, keeping whitespace attached to the
  // preceding token. `/.../` global with a capture-free pattern.
  const tokens = text.match(/\s*\S+/g);
  if (!tokens) return text.length > 0 ? [text] : [];
  // A leading-whitespace remainder is preserved as its own token.
  const consumed = tokens.join('');
  if (consumed.length < text.length) {
    const remainder = text.slice(consumed.length);
    if (remainder) tokens.push(remainder);
  }
  return tokens;
}

/**
 * Computes a word-level diff between two strings.
 *
 * LCS over tokens. For long inputs the O(n·m) table is bounded by a guard that
 * falls back to a coarse whole-string comparison, so a pathological chapter
 * never freezes the UI.
 */
export function diffWords(original: string, revised: string): DiffToken[] {
  const a = tokenizeWords(original);
  const b = tokenizeWords(revised);

  // Guard: refuse to allocate a huge table; treat as full replace.
  if (a.length * b.length > 4_000_000) {
    const result: DiffToken[] = [];
    if (original) result.push({ op: 'delete', text: original });
    if (revised) result.push({ op: 'insert', text: revised });
    return result;
  }

  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]. Built bottom-up into typed rows.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      tokens.push({ op: 'equal', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ op: 'delete', text: a[i] });
      i += 1;
    } else {
      tokens.push({ op: 'insert', text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    tokens.push({ op: 'delete', text: a[i] });
    i += 1;
  }
  while (j < m) {
    tokens.push({ op: 'insert', text: b[j] });
    j += 1;
  }

  return coalesce(tokens);
}

/** Merges adjacent tokens with the same op, for cleaner rendering. */
function coalesce(tokens: DiffToken[]): DiffToken[] {
  const merged: DiffToken[] = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (last && last.op === token.op) {
      last.text += token.text;
    } else {
      merged.push({ ...token });
    }
  }
  return merged;
}

/** True when the two strings are identical (nothing to apply). */
export function isIdentical(a: string, b: string): boolean {
  return a === b;
}
