import type { DocumentFormat, DocumentSectionLevel } from '@/schemas/document';

/**
 * Pure document parser for the import pipeline (P8 Batch 1).
 *
 * Responsibilities are deliberately limited to TEXT → SECTIONS with exact,
 * verifiable offsets. No persistence, no React, no AI. Every function here is
 * pure and deterministic so it can be exercised in plain Node.
 *
 * ## Offset contract (the most important invariant)
 *
 * The parser NEVER rewrites the source text it indexes. It works on a
 * "normalised view" produced by `normalizeText`, but crucially it records the
 * mapping from every normalised index back to the ORIGINAL raw text index.
 *
 * The sections it returns carry offsets into the ORIGINAL `rawText`, using JS
 * UTF-16 code-unit indices in a left-closed / right-open interval `[start, end)`.
 * By construction:
 *
 *     rawText.slice(section.start, section.end) === section.text
 *
 * holds for every section, including with CRLF line endings, emoji (surrogate
 * pairs) and CJK text. `parseDocument` re-verifies this for every produced
 * section and throws if it is ever violated — so a bug can never silently
 * persist a mis-aligned section.
 *
 * ## Structure detection is CONSERVATIVE
 *
 * We only assign a structural level when the evidence is unambiguous:
 *   - Markdown ATX headings (`#`, `##`, `###`) → volume / chapter / scene by depth.
 *   - Common numbered chapter headings ("第1章", "第一章", "Chapter 1", "卷一").
 *   - Explicit scene separators (`---`, `***`, `* * *`, `◇◇◇` …).
 * Everything else stays as `paragraph` and is grouped under the current heading.
 * A document with no headings parses to a single implicit chapter of paragraphs
 * — we never fabricate scenes or volumes that the text does not mark.
 */

/* -------------------------------------------------------------------------- */
/* Public shapes                                                              */
/* -------------------------------------------------------------------------- */

/** A parsed section, ready to persist (offsets are into the ORIGINAL raw text). */
export interface ParsedSection {
  level: DocumentSectionLevel;
  title: string;
  /** Order among ALL produced sections (flat, ascending), stable. */
  order: number;
  /** UTF-16 code-unit offset into the original raw text, inclusive. */
  start: number;
  /** UTF-16 code-unit offset into the original raw text, exclusive. */
  end: number;
  /** Exactly `rawText.slice(start, end)`. */
  text: string;
  /** Index (into the returned `sections`) of the parent, or -1 at root. */
  parentIndex: number;
}

/** The full result of parsing a document. */
export interface ParseResult {
  sections: ParsedSection[];
  /** Counts of sections by level (for UI summaries). */
  counts: Record<DocumentSectionLevel, number>;
  /** True when at least one real structural heading was recognised. */
  hasStructure: boolean;
}

/** Raised when parsing cannot satisfy its structural invariants. */
export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

/* -------------------------------------------------------------------------- */
/* Text statistics                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Counts "words" in a manuscript-friendly, CJK-aware way.
 *
 * Latin/Cyrillic/etc. runs count as words; every CJK ideograph counts as one
 * word (since CJK prose has no spaces). Pure and deterministic. An offline
 * approximation — never claimed to equal a specific vendor's tokenizer.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  // Count CJK characters individually.
  const cjk = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const cjkCount = cjk ? cjk.length : 0;
  // Remove CJK so the word-run regex does not double count.
  const nonCjk = text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const runs = nonCjk.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  const runCount = runs ? runs.length : 0;
  return cjkCount + runCount;
}

/* -------------------------------------------------------------------------- */
/* Normalisation with offset mapping                                          */
/* -------------------------------------------------------------------------- */

/** A normalised text plus the mapping from each normalised index → raw index. */
export interface NormalisedText {
  /** The normalised view (CRLF→LF, lone CR→LF, BOM stripped). */
  text: string;
  /**
   * `rawIndex[i]` is the index in the original raw text of the source character
   * that produced normalised character `i`. Has `text.length + 1` entries; the
   * final entry is `rawText.length` so an exclusive end maps cleanly.
   */
  rawIndex: number[];
}

/**
 * Normalises text for structure scanning WITHOUT losing positions.
 *
 * Transformations (each recorded in the index map):
 *   - Strip a leading UTF-8 BOM (`\uFEFF`).
 *   - Convert CRLF (`\r\n`) → `\n`.
 *   - Convert lone CR (`\r`) → `\n`.
 *
 * No other change is made: characters are NOT trimmed, collapsed or reordered,
 * so every normalised index maps to exactly one raw index. This is what lets us
 * scan a tidy `\n`-based view while still reporting offsets into the raw text.
 */
export function normalizeText(rawText: string): NormalisedText {
  const rawIndex: number[] = [];
  let out = '';
  let i = 0;

  // Strip a single leading BOM.
  if (rawText.charCodeAt(0) === 0xfeff) {
    i = 1;
  }

  for (; i < rawText.length; i += 1) {
    const ch = rawText[i];
    if (ch === '\r') {
      // CRLF → single '\n' mapped to the CR's raw position.
      if (rawText[i + 1] === '\n') {
        out += '\n';
        rawIndex.push(i);
        i += 1; // consume the LF as part of the pair
      } else {
        out += '\n';
        rawIndex.push(i);
      }
    } else {
      out += ch;
      rawIndex.push(i);
    }
  }
  // Exclusive end sentinel.
  rawIndex.push(rawText.length);

  return { text: out, rawIndex };
}

/* -------------------------------------------------------------------------- */
/* Heading detection                                                          */
/* -------------------------------------------------------------------------- */

/** Markdown ATX heading: 1–6 leading `#`, a space, then text. */
const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Chinese numeric chapter: 第<阿拉伯数字 or 中文数字>章 / 回 / 节 / 卷 … */
const CN_NUMBERED_RE =
  /^\s*第\s*([0-9０-９一二三四五六七八九十百千零两]+)\s*([章回节節卷部篇集])(?:\s|[:：、.．\-—]|$)/;

/** Latin "Chapter 12", "Chapter Twelve", optional following title. */
const EN_CHAPTER_RE = /^\s*(chapter|book|part|scene)\b\s*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)?\b/i;

/** A scene-only separator line made of ≥3 identical/symbolic marks. */
const SCENE_SEPARATOR_RE = /^\s*(?:[-*=~#•·—◇◆◇◆❖✦✧*]\s*){3,}$/;

/**
 * Classifies a normalised line as a heading, if it clearly is one.
 *
 * Returns `null` for ordinary prose (the common case) so paragraphs are never
 * mistaken for structure. `separatorOnly` reports whether the line is a scene
 * break rather than a titled heading.
 */
function classifyHeadingLine(line: string): { type: 'heading'; level: DocumentSectionLevel; title: string } | { type: 'separator' } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  // Explicit scene separator wins over other interpretations.
  if (SCENE_SEPARATOR_RE.test(trimmed)) {
    return { type: 'separator' };
  }

  // Markdown ATX headings: depth 1 → volume-ish, 2 → chapter, 3+ → scene.
  const md = MD_HEADING_RE.exec(trimmed);
  if (md) {
    const depth = md[1].length;
    const title = md[2].trim();
    if (title.length === 0) return null;
    const level: DocumentSectionLevel = depth === 1 ? 'volume' : depth === 2 ? 'chapter' : 'scene';
    return { type: 'heading', level, title };
  }

  // Chinese numbered headings.
  const cn = CN_NUMBERED_RE.exec(trimmed);
  if (cn) {
    const marker = cn[2];
    const isVolume = marker === '卷' || marker === '部' || marker === '集' || marker === '篇';
    const level: DocumentSectionLevel = isVolume ? 'volume' : 'chapter';
    // Keep the heading text as the whole trimmed line (bounded by caller).
    return { type: 'heading', level, title: trimmed };
  }

  // English chapter-style headings.
  const en = EN_CHAPTER_RE.exec(trimmed);
  if (en) {
    const word = en[1].toLowerCase();
    // "scene" → scene; "chapter"/"book"/"part" → chapter/volume-ish.
    const level: DocumentSectionLevel =
      word === 'scene' ? 'scene' : word === 'book' || word === 'part' ? 'volume' : 'chapter';
    // Require it to actually look like a heading: short line, not ending in a
    // sentence period that suggests prose ("Chapter 1 was long and..."). We only
    // accept when the remainder after the keyword is short or absent.
    const rest = trimmed.slice(en[0].length).trim();
    if (rest.length > 60) return null;
    return { type: 'heading', level, title: trimmed };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Public: detectStructure                                                    */
/* -------------------------------------------------------------------------- */

/** A detected structural break (heading or separator) in normalised coordinates. */
export interface StructureMarker {
  kind: 'heading' | 'separator';
  level?: DocumentSectionLevel;
  title?: string;
  /** Normalised offset of the line start. */
  normStart: number;
  /** Normalised offset just past the line (including its newline). */
  normLineEnd: number;
}

/**
 * Scans the normalised text and returns ordered structural markers.
 *
 * Pure and exposed for testing. Separators carry no level/title. Only lines that
 * unambiguously look like headings/separators are returned; all other content is
 * ignored here and becomes paragraph text later.
 */
export function detectStructure(normalised: NormalisedText): StructureMarker[] {
  const markers: StructureMarker[] = [];
  const text = normalised.text;

  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const atEnd = i === text.length;
    if (atEnd || text[i] === '\n') {
      const line = text.slice(lineStart, i);
      const lineEnd = atEnd ? i : i + 1; // include the newline
      const classified = classifyHeadingLine(line);
      if (classified?.type === 'heading') {
        markers.push({
          kind: 'heading',
          level: classified.level,
          title: classified.title,
          normStart: lineStart,
          normLineEnd: lineEnd,
        });
      } else if (classified?.type === 'separator') {
        markers.push({ kind: 'separator', normStart: lineStart, normLineEnd: lineEnd });
      }
      lineStart = lineEnd;
    }
  }
  return markers;
}

/* -------------------------------------------------------------------------- */
/* Public: parseDocument                                                      */
/* -------------------------------------------------------------------------- */

const MAX_TITLE_CHARS = 300;
const MIN_TITLE_CHARS = 1;

/**
 * Splits a heading title, falling back to a positional label when empty.
 */
function safeTitle(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= MIN_TITLE_CHARS) {
    return trimmed.length > MAX_TITLE_CHARS ? trimmed.slice(0, MAX_TITLE_CHARS) : trimmed;
  }
  return fallback;
}

/** Maps a normalised offset to the ORIGINAL raw offset via the index map. */
function toRaw(normalised: NormalisedText, normIndex: number): number {
  if (normIndex <= 0) return normalised.rawIndex[0] ?? 0;
  if (normIndex >= normalised.text.length) return normalised.rawIndex[normalised.text.length] ?? normalised.text.length;
  return normalised.rawIndex[normIndex];
}

/**
 * Parses raw document text into ordered, offset-exact sections.
 *
 * Strategy:
 *   - Normalise for scanning while retaining the raw index map.
 *   - Walk the text, splitting at every detected structural marker.
 *   - Emit a heading section (volume/chapter/scene) for each titled marker; its
 *     `start` is the heading line start, `end` is the next structural marker (or
 *     EOF), so the heading's own text is included in its block.
 *   - Emit `paragraph` sections for non-empty prose chunks between markers,
 *     grouped under the most recent heading of appropriate level.
 *   - If NO headings exist, wrap everything in one implicit `chapter` and emit
 *     paragraphs beneath it (never fabricate deeper structure).
 *
 * Every returned section is verified with `rawText.slice(start,end) === text`;
 * any mismatch throws `DocumentParseError` (this should be impossible).
 */
export function parseDocument(rawText: string, _format: DocumentFormat = 'txt'): ParseResult {
  if (typeof rawText !== 'string') {
    throw new DocumentParseError('Document text must be a string.');
  }
  if (rawText.length === 0) {
    throw new DocumentParseError('Cannot parse an empty document.');
  }

  const normalised = normalizeText(rawText);
  const markers = detectStructure(normalised);
  // `hasStructure` reflects only REAL recognised headings. The implicit wrapper
  // chapter added for heading-less documents is NOT "structure".
  const hadHeadings = markers.some((m) => m.kind === 'heading');

  const sections: ParsedSection[] = [];
  let order = 0;

  // Stack of open headings by level, to resolve parent indices.
  const levelStack: Array<{ level: DocumentSectionLevel; index: number }> = [];

  const levelRank = (level: DocumentSectionLevel): number => {
    switch (level) {
      case 'volume':
        return 0;
      case 'chapter':
        return 1;
      case 'scene':
        return 2;
      case 'paragraph':
        return 3;
      default:
        return 3;
    }
  };

  /** Finds the nearest open ancestor whose level outranks `level`. */
  const resolveParent = (level: DocumentSectionLevel): number => {
    const rank = levelRank(level);
    // Pop headings that are not strictly "above" this level.
    while (levelStack.length > 0 && levelRank(levelStack[levelStack.length - 1].level) >= rank) {
      levelStack.pop();
    }
    return levelStack.length > 0 ? levelStack[levelStack.length - 1].index : -1;
  };

  /** Pushes a section, verifying + recording the offset invariant. */
  const push = (level: DocumentSectionLevel, title: string, rawStart: number, rawEnd: number, parentIndex: number) => {
    if (rawEnd < rawStart) {
      throw new DocumentParseError(`Invalid section range [${rawStart}, ${rawEnd}).`);
    }
    const text = rawText.slice(rawStart, rawEnd);
    const section: ParsedSection = {
      level,
      title,
      order: order++,
      start: rawStart,
      end: rawEnd,
      text,
      parentIndex,
    };
    sections.push(section);
    return sections.length - 1;
  };

  const emitParagraphs = (fromNorm: number, toNorm: number, parentIndex: number) => {
    if (toNorm <= fromNorm) return;
    // Split the slice into paragraph chunks separated by one or more newlines
    // (or lines that are only whitespace). Each chunk keeps its exact offsets.
    let cursor = fromNorm;
    let paraStart = -1;
    let paraEnd = -1;
    const flush = () => {
      if (paraStart < 0) return;
      const rawStart = toRaw(normalised, paraStart);
      const rawEnd = toRaw(normalised, paraEnd);
      if (rawEnd > rawStart) {
        push('paragraph', '', rawStart, rawEnd, parentIndex);
      }
      paraStart = -1;
      paraEnd = -1;
    };

    for (; cursor < toNorm; cursor += 1) {
      const ch = normalised.text[cursor];
      const isLineBreak = ch === '\n';
      if (isLineBreak) {
        // A blank line (two consecutive newlines) ends the paragraph.
        const next = cursor + 1 < toNorm ? normalised.text[cursor + 1] : '';
        if (next === '\n') {
          if (paraStart >= 0) {
            paraEnd = cursor; // exclude the newline from the paragraph text
            flush();
          }
          cursor += 1; // consume the second newline
          continue;
        }
        if (paraStart < 0) {
          // Leading newline: skip empty space before the paragraph.
          continue;
        }
        paraEnd = cursor;
        flush();
        continue;
      }
      if (paraStart < 0) paraStart = cursor;
      paraEnd = cursor + 1;
    }
    flush();
  };

  // No structure at all → one implicit chapter containing all paragraphs.
  if (markers.length === 0) {
    const chapterIndex = push('chapter', 'Document', 0, rawText.length, -1);
    levelStack.push({ level: 'chapter', index: chapterIndex });
    emitParagraphs(0, normalised.text.length, chapterIndex);
    return finalise(rawText, sections, hadHeadings);
  }

  // Content BEFORE the first marker → an implicit chapter (if non-empty prose).
  const firstMarkerStart = markers[0].normStart;
  if (firstMarkerStart > 0) {
    const rawEnd = toRaw(normalised, firstMarkerStart);
    const leading = rawText.slice(0, rawEnd);
    if (leading.trim().length > 0) {
      const chapterIndex = push('chapter', 'Document', 0, rawEnd, -1);
      levelStack.push({ level: 'chapter', index: chapterIndex });
      emitParagraphs(0, firstMarkerStart, chapterIndex);
    }
  }

  // Iterate markers; each heading block runs until the next structural marker.
  for (let m = 0; m < markers.length; m += 1) {
    const marker = markers[m];
    const isLast = m === markers.length - 1;
    const blockEndNorm = isLast ? normalised.text.length : markers[m + 1].normStart;

    if (marker.kind === 'separator') {
      // A separator does not open a titled section; it only ends the current
      // text chunk. Any prose between it and the next marker becomes paragraphs
      // under the current heading. (The separator line itself is structure, so
      // we simply move on.)
      const parentIndex = levelStack.length > 0 ? levelStack[levelStack.length - 1].index : -1;
      emitParagraphs(marker.normLineEnd, blockEndNorm, parentIndex);
      continue;
    }

    const level = marker.level ?? 'chapter';
    const title = safeTitle(marker.title ?? '', `Section ${order + 1}`);
    const parentIndex = resolveParent(level);

    const rawStart = toRaw(normalised, marker.normStart);
    const rawEnd = toRaw(normalised, blockEndNorm);

    const headingIndex = push(level, title, rawStart, rawEnd, parentIndex);
    levelStack.push({ level, index: headingIndex });

    // Paragraphs in the body of this heading (after the heading line itself).
    const bodyStartNorm = marker.normLineEnd;
    // The next marker may be a heading of equal/higher rank; its content still
    // belongs to THIS block only up to the next marker, so paragraphs are the
    // text between the heading line and blockEnd (minus nested markers, which
    // are handled because we process markers sequentially — nested heading
    // blocks will re-slice their own start). To avoid double-counting nested
    // headings, we only emit paragraphs here for the immediate line range up to
    // the next marker, which is exactly [bodyStartNorm, blockEndNorm) when the
    // next marker is the following heading's start.
    emitParagraphs(bodyStartNorm, blockEndNorm, headingIndex);
  }

  return finalise(rawText, sections, hadHeadings);
}

/** Computes counts and verifies every section's slice invariant. */
function finalise(rawText: string, sections: ParsedSection[], hadHeadings: boolean): ParseResult {
  const counts: Record<DocumentSectionLevel, number> = {
    volume: 0,
    chapter: 0,
    scene: 0,
    paragraph: 0,
  };

  for (const section of sections) {
    counts[section.level] += 1;
    const slice = rawText.slice(section.start, section.end);
    if (slice !== section.text) {
      throw new DocumentParseError(
        `Section offset invariant violated at order ${section.order}: ` +
          `rawText.slice(${section.start}, ${section.end}) did not equal the section text.`,
      );
    }
  }

  return { sections, counts, hasStructure: hadHeadings };
}
