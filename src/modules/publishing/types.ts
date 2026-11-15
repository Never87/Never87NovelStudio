/**
 * Publishing & Export domain types (P9 Batch A — shared foundation).
 *
 * This module is the single source of truth for the three layers of the
 * publishing pipeline:
 *
 *   BookAssemblyModel  → (FormattingPipeline + Preset) → RenderedDocument → writer
 *
 * Everything here is PURE DATA: no React, no Dexie, no browser APIs. Writers
 * consume a `RenderedDocument` and nothing else; the pipeline consumes an
 * `BookAssemblyModel` and a `PublishingPreset` and applies the preset EXACTLY
 * once, so preview and download can never diverge (both derive from the same
 * IR, see Batch B).
 *
 * The types deliberately follow the project's tsconfig constraints:
 *   - `erasableSyntaxOnly`: no `enum`; string-literal unions instead.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* ========================================================================== */
/* Book assembly model                                                        */
/* ========================================================================== */

/** Per-chapter text statistics carried through to the model (read-only). */
export interface AssemblyChapterStats {
  /** Word count as stored on the chapter draft (CJK + Latin aware). */
  readonly wordCount: number;
  /** Character count as stored on the chapter draft (whitespace excluded). */
  readonly characterCount: number;
}

/**
 * How a chapter's prose was resolved during assembly.
 *
 *  - `draft`      — a `ChapterDraft` existed and its Markdown was used verbatim.
 *  - `empty`      — no `ChapterDraft` exists yet; the chapter is represented
 *                   with empty Markdown (never silently dropped).
 *
 * SceneDraft prose is NEVER part of this model's chapter content — the
 * authoritative source for exported chapter prose is the `ChapterDraft`.
 */
export type AssemblyChapterSource = 'draft' | 'empty';

/** One chapter inside the assembly model, with its manuscript body. */
export interface AssemblyChapter {
  readonly id: string;
  /** Owning volume id (already ordered under `AssemblyVolume`). */
  readonly volumeId: string;
  /** Canonical chapter title. */
  readonly title: string;
  /** Canonical chapter order within its volume (ascending). */
  readonly order: number;
  /** Lifecycle status snapshot (informational only — not used to filter). */
  readonly status: string;
  /** Where the prose came from (`draft` or typed `empty` state). */
  readonly source: AssemblyChapterSource;
  /**
   * The chapter's Markdown manuscript. This is the AUTHORITATIVE, default
   * export source and is NEVER concatenated with scene prose.
   */
  readonly content: string;
  /** Derived text statistics for the chapter. */
  readonly stats: AssemblyChapterStats;
  /** Number of scenes belonging to the chapter (planning metadata, no prose). */
  readonly sceneCount: number;
}

/** One volume with its chapters, in canonical project order. */
export interface AssemblyVolume {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Chapters in canonical chapter order (`order` ascending). */
  readonly chapters: readonly AssemblyChapter[];
}

/** Project metadata needed for publishing (a safe subset of `NovelProject`). */
export interface AssemblyProjectMetadata {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Author from project settings, or `''` when unset. */
  readonly author: string;
  /** Language tag from project settings, or `''` when unset. */
  readonly language: string;
  /** Project genre labels (informational). */
  readonly genre: readonly string[];
  /** Project tag labels (informational). */
  readonly tags: readonly string[];
}

/**
 * The read-only book assembly model produced by `BookAssemblyService`.
 *
 * Deterministic for unchanged project data: volumes and chapters keep the
 * canonical order the existing services return, and nothing is re-sorted by
 * title or creation time here.
 */
export interface BookAssemblyModel {
  readonly project: AssemblyProjectMetadata;
  /** Volumes in canonical project order, each with ordered chapters. */
  readonly volumes: readonly AssemblyVolume[];
  /** Aggregate counts for callers that need them without re-walking. */
  readonly totalChapters: number;
  readonly totalWords: number;
}

/* ========================================================================== */
/* Publishing presets                                                         */
/* ========================================================================== */

/** How a chapter heading is rendered. */
export type ChapterHeadingStyle = 'none' | 'number' | 'number-padded' | 'label';

/**
 * How paragraphs are separated / indented.
 *
 *  - `indent`:       first-line indent (see `paragraphIndent`), blank line between paragraphs.
 *  - `indent-only`:  first-line indent, no blank line between paragraphs.
 *  - `blank-line`:   no first-line indent, blank line between paragraphs.
 *  - `flush`:        no first-line indent, no blank line between paragraphs.
 */
export type ParagraphStyle = 'indent' | 'indent-only' | 'blank-line' | 'flush';

/** Document title / author metadata policy for the document header. */
export type MetadataPolicy = 'none' | 'title' | 'title-and-author';

/** A concrete formatting preset (built-in, or a future custom preset). */
export interface PublishingPreset {
  /** Stable, human-readable identifier (e.g. `generic`). */
  readonly id: string;
  /** Display label shown in a future preset picker. */
  readonly label: string;
  /**
   * Whether this preset is a built-in. Custom presets (future) set this to
   * `false`; nothing in this batch persists them.
   */
  readonly builtin: boolean;

  /** Document-level metadata header policy. */
  readonly metadata: MetadataPolicy;

  /** Whether volume headings are included in the output. */
  readonly includeVolumeHeadings: boolean;
  /** Heading text template for a volume (`{title}` / `{index}` placeholders). */
  readonly volumeHeadingTemplate: string;

  /** Chapter heading style. */
  readonly chapterHeadingStyle: ChapterHeadingStyle;
  /** Heading text template for a chapter (`{title}` / `{index}` placeholders). */
  readonly chapterHeadingTemplate: string;

  /** Paragraph layout policy. */
  readonly paragraphStyle: ParagraphStyle;
  /** Number of full-width / space characters used for a first-line indent. */
  readonly paragraphIndent: number;
  /** Blank lines emitted between paragraphs when the style uses blank lines. */
  readonly paragraphSpacing: number;

  /** Representation for an explicit scene break (e.g. `* * *`). */
  readonly sceneBreak: string;

  /**
   * File-name template. Placeholders: `{title}`, `{author}`. The extension is
   * appended by the filename utility (never included here).
   */
  readonly fileNameTemplate: string;

  /** Preferred file extension WITHOUT a dot (e.g. `txt`, `md`). */
  readonly fileExtension: string;
}

/**
 * A user-defined preset (future UI). Same shape as a built-in preset but
 * `builtin` is always `false`. Defined here for type completeness only — no
 * creation, editing or persistence exists in this batch.
 */
export type CustomPublishingPreset = PublishingPreset & { readonly builtin: false };

/* ========================================================================== */
/* RenderedDocument — format-neutral intermediate representation             */
/* ========================================================================== */

/** A single block inside a rendered section. */
export type RenderedBlock =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'scene-break'; readonly text: string };

/** One chapter rendered into blocks (heading + body). */
export interface RenderedChapter {
  readonly id: string;
  readonly title: string;
  /** Blocks in document order (heading first when the preset emits one). */
  readonly blocks: readonly RenderedBlock[];
}

/** One volume rendered into its ordered chapters. */
export interface RenderedVolume {
  readonly id: string;
  readonly title: string;
  /** Volume heading block, or `null` when the preset hides volume headings. */
  readonly heading: RenderedBlock | null;
  readonly chapters: readonly RenderedChapter[];
}

/** Document-level metadata carried into every writer. */
export interface RenderedDocumentMetadata {
  readonly title: string;
  readonly author: string;
  readonly language: string;
}

/**
 * The format-neutral intermediate representation.
 *
 * It preserves the semantic structure (volumes, chapters, headings, paragraphs,
 * scene breaks) needed by all three initial writers; the whole book is NEVER
 * flattened to a single string at this stage. It is a plain, immutable data
 * structure with no behaviour.
 */
export interface RenderedDocument {
  readonly metadata: RenderedDocumentMetadata;
  /** The preset that produced this IR (its id is stable & recorded). */
  readonly presetId: string;
  /** `true` when a document header (title/author) should be emitted. */
  readonly header: RenderedBlock | null;
  readonly volumes: readonly RenderedVolume[];
}
