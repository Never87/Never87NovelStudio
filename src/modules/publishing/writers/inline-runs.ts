/**
 * Inline-format tokenizer shared by the structured writers (DOCX/EPUB/PDF).
 *
 * The Batch A `RenderedDocument` keeps chapter prose largely as plain paragraph
 * text with a SMALL, well-bounded subset of inline Markdown preserved verbatim:
 * `**bold**`, `*italic*` and `` `code` `` (the exact subset the HTML writer
 * renders). The binary writers must honour the same subset so the exported DOCX/
 * EPUB/PDF carries the author's emphasis.
 *
 * This module turns a paragraph string into an ordered list of styled runs. It
 * is deliberately tiny and non-HTML: it NEVER produces markup, only
 * `{ text, bold, italic, code }` records. Markdown markers that are not one of
 * the three supported forms are left as literal text (never dropped).
 *
 * The parser is intentionally conservative (no nesting, no links) to match the
 * HTML writer's behaviour, so all writers agree on what is emphasised.
 */

/** A styled span of text within a paragraph. */
export interface InlineRun {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: boolean;
}

/** Matches `**bold**` (non-greedy, single-line, no asterisk inside). */
const BOLD = /\*\*([^*]+)\*\*/;
/** Matches `*italic*` (single asterisk, non-greedy). */
const ITALIC = /(^|[^*])\*([^*]+)\*/;
/** Matches `` `code` ``. */
const CODE = /`([^`]+)`/;

/**
 * Splits one paragraph `text` into runs with inline styling applied.
 *
 * Preference order on each scan: code first (so emphasis markers inside code are
 * not misinterpreted), then bold, then italic. Everything between tokens is
 * emitted as unstyled text. Text is preserved verbatim (only the matched markers
 * are removed).
 */
export function parseInlineRuns(text: string): InlineRun[] {
  const source = (text ?? '').replace(/\r\n?/g, '\n');
  const runs: InlineRun[] = [];

  const pushPlain = (chunk: string) => {
    if (chunk.length > 0) runs.push({ text: chunk, bold: false, italic: false, code: false });
  };

  let remaining = source;
  // Guard against pathological input by bounding the number of iterations.
  let guard = 0;
  while (remaining.length > 0 && guard < 100_000) {
    guard += 1;
    const codeMatch = CODE.exec(remaining);
    const boldMatch = BOLD.exec(remaining);
    const italicMatch = ITALIC.exec(remaining);

    // Find the earliest match of any kind.
    const candidates: Array<{ index: number; length: number; run: InlineRun; prefix: string }> = [];
    if (codeMatch) {
      candidates.push({
        index: codeMatch.index,
        length: codeMatch[0].length,
        run: { text: codeMatch[1], bold: false, italic: false, code: true },
        prefix: '',
      });
    }
    if (boldMatch) {
      candidates.push({
        index: boldMatch.index,
        length: boldMatch[0].length,
        run: { text: boldMatch[1], bold: true, italic: false, code: false },
        prefix: '',
      });
    }
    if (italicMatch) {
      // The italic pattern captures a leading prefix char (to avoid matching the
      // second asterisk of a `**` pair); fold it back into the preceding text.
      const leading = italicMatch[1] ?? '';
      candidates.push({
        index: italicMatch.index + leading.length,
        length: italicMatch[0].length - leading.length,
        run: { text: italicMatch[2], bold: false, italic: true, code: false },
        prefix: leading,
      });
    }

    if (candidates.length === 0) {
      pushPlain(remaining);
      break;
    }

    candidates.sort((a, b) => a.index - b.index);
    const next = candidates[0];

    if (next.index > 0) pushPlain(remaining.slice(0, next.index));
    if (next.prefix) pushPlain(next.prefix);
    runs.push(next.run);
    remaining = remaining.slice(next.index + next.length);
  }

  // Merge adjacent unstyled runs so callers don't emit redundant spans.
  return mergeRuns(runs);
}

/** Coalesces neighbouring runs that share identical styling. */
function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const merged: InlineRun[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.code === run.code
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + run.text };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

/** Convenience: true when the paragraph contains no styling at all. */
export function isPlainText(text: string): boolean {
  return !BOLD.test(text) && !CODE.test(text) && !ITALIC.test(text);
}
