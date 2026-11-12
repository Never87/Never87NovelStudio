import { z } from 'zod';

/**
 * Manuscript domain schemas (single source of truth for the writing layer).
 *
 * P4 adds TWO manuscript containers so prose can live either on a chapter or on
 * a scene:
 *
 *   - `SceneDraft`  — the prose of one scene (1:1 with a `Scene`).
 *   - `ChapterDraft`— the prose of a chapter (1:1 with a `Chapter`).
 *
 * Prose is stored as **Markdown** (`content`) plus a cached plain-text body
 * (`plainText`) used for word counts, search and list previews. The cache is
 * derived data: the Service always recomputes it, so the two can never drift.
 *
 * Version history lives in `DraftVersion`, an append-only snapshot log keyed by
 * `draftId`. Snapshots are immutable once written; restoring a version writes a
 * NEW current draft (it never mutates history).
 *
 * Same tsconfig constraints as the other schemas:
 *   - `erasableSyntaxOnly`: no `enum`, use literal unions.
 *   - `verbatimModuleSyntax`: type-only imports must use `import type`.
 */

/** Which manuscript container a draft/version belongs to. */
export const DRAFT_KINDS = ['chapter', 'scene'] as const;

export const DraftKindSchema = z.enum(DRAFT_KINDS);

/** Why a version snapshot was captured. */
export const DRAFT_VERSION_REASONS = ['auto', 'manual', 'restore'] as const;

export const DraftVersionReasonSchema = z.enum(DRAFT_VERSION_REASONS);

/**
 * Upper bound for a single manuscript body.
 *
 * Deliberately far above the 20 000-character review/planning text limits:
 * a chapter is prose, and long chapters are legitimate. ~2 M characters is
 * well beyond any realistic novel chapter while still bounding a corrupt write.
 */
export const MAX_DRAFT_CHARS = 2_000_000;

/** Maximum number of retained snapshots per draft. Oldest are pruned first. */
export const MAX_VERSIONS_PER_DRAFT = 30;

const draftIdSchema = z.string().min(1, 'Draft id is required');

/** Unix epoch milliseconds. Rejects negatives and non-integers. */
const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/** Shared shape checks for both draft kinds. */
const draftBaseShape = {
  /** Stable primary key, prefixed (`cdraft_…` / `sdraft_…`). */
  id: z.string().min(1, 'Draft id is required'),
  /** Owning project — denormalised for per-project queries and cascades. */
  projectId: z.string().min(1, 'Draft projectId is required'),
  /** The chapter (ChapterDraft) or scene (SceneDraft) this prose belongs to. */
  ownerId: z.string().min(1, 'Draft ownerId is required'),
  /** Markdown source of truth. */
  content: z
    .string()
    .max(MAX_DRAFT_CHARS, `Content must be at most ${MAX_DRAFT_CHARS} characters`),
  /** Cached plain text derived from `content` (never hand-edited). */
  plainText: z
    .string()
    .max(MAX_DRAFT_CHARS + 10_000, 'Plain text cache is too large'),
  /** Word count of `plainText`, recomputed by the Service. */
  wordCount: z.number().int('Word count must be an integer').nonnegative('Word count must be non-negative'),
  /** Character count of `plainText`, recomputed by the Service. */
  characterCount: z
    .number()
    .int('Character count must be an integer')
    .nonnegative('Character count must be non-negative'),
  /**
   * Monotonic revision counter, incremented on every write by the Service.
   * Autosave uses it for optimistic concurrency: an update whose
   * `expectedRevision` no longer matches is rejected so an older request can
   * never overwrite newer content.
   */
  revision: z.number().int('Revision must be an integer').nonnegative('Revision must be non-negative'),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** Prose of a single chapter. */
export const ChapterDraftSchema = z
  .object({
    ...draftBaseShape,
    kind: z.literal('chapter'),
  })
  .strict()
  .refine((draft) => draft.updatedAt >= draft.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/** Prose of a single scene. */
export const SceneDraftSchema = z
  .object({
    ...draftBaseShape,
    kind: z.literal('scene'),
  })
  .strict()
  .refine((draft) => draft.updatedAt >= draft.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

/**
 * A historical snapshot of a draft.
 *
 * `revision` is the revision the snapshot was captured at, so versions order
 * deterministically even when two share a timestamp.
 */
export const DraftVersionSchema = z
  .object({
    /** Stable primary key, prefixed (`dver_…`). */
    id: z.string().min(1, 'Version id is required'),
    /** Id of the draft this snapshot belongs to. */
    draftId: draftIdSchema,
    /** Owning project — denormalised for cascade deletes. */
    projectId: z.string().min(1, 'Version projectId is required'),
    /** Draft kind, so a version can be filtered/restored without a join. */
    kind: DraftKindSchema,
    /** Revision at capture time. */
    revision: z.number().int('Revision must be an integer').nonnegative(),
    content: z
      .string()
      .max(MAX_DRAFT_CHARS, `Content must be at most ${MAX_DRAFT_CHARS} characters`),
    wordCount: z.number().int().nonnegative(),
    reason: DraftVersionReasonSchema,
    /** Optional human note (kept short — it is a label, not a document). */
    label: z.string().trim().max(200, 'Label must be at most 200 characters'),
    createdAt: timestampSchema,
  })
  .strict();

/** Draft kinds. */
export type DraftKind = z.infer<typeof DraftKindSchema>;
/** Why a version was captured. */
export type DraftVersionReason = z.infer<typeof DraftVersionReasonSchema>;
/** Chapter manuscript record. */
export type ChapterDraft = z.infer<typeof ChapterDraftSchema>;
/** Scene manuscript record. */
export type SceneDraft = z.infer<typeof SceneDraftSchema>;
/** Either manuscript record. */
export type Draft = ChapterDraft | SceneDraft;
/** A historical snapshot of a draft. */
export type DraftVersion = z.infer<typeof DraftVersionSchema>;
