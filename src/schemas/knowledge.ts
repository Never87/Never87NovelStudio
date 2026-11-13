import { z } from 'zod';

/**
 * Knowledge Base domain schemas (P7) — single source of truth.
 *
 * The Knowledge Base is a SEARCHABLE index of the structured facts that already
 * live across a project (characters, locations, factions, world rules, events,
 * chapters, scenes, timeline events, foreshadowing) plus user-authored entries.
 *
 * Design principles (inherited from P1–P6):
 *   - Every entry belongs to exactly ONE project (`projectId`, indexed).
 *   - Types are DERIVED from these Zod schemas via `z.infer` — never hand-written.
 *   - Entries may carry a SOURCE REFERENCE (`source`) back to the originating
 *     entity so a user can trace an entry to its record. Reference imports are
 *     idempotent: the `source` key is unique per project (see the Service).
 *   - Evidence uses chapter/scene-level source identification at minimum, with
 *     optional quote and offset for precise positioning.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Evidence — shared by Knowledge & Analysis                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where a fact/finding was drawn from.
 *
 * Chapter/scene-level identification is the MINIMUM. `quote` and `offset` are
 * OPTIONAL and add precise positioning inside the source, but never replace the
 * locator (a quote alone — without a chapter/scene — is not evidence).
 *
 * `offset` is a character offset into the source scene/chapter prose when known.
 */
export const EvidenceSchema = z
  .object({
    /** Owning chapter, when the evidence sits in a chapter. */
    chapterId: z.string().min(1).nullable(),
    /** Owning scene, when the evidence sits in a scene. */
    sceneId: z.string().min(1).nullable(),
    /** Verbatim quote from the source (optional, ≤ 4000 chars). */
    quote: z.string().max(4_000, 'A quote must be at most 4000 characters').default(''),
    /** Character offset into the source prose, when known (≥ 0). */
    offset: z.number().int('Offset must be an integer').nonnegative('Offset must be non-negative').nullable(),
    /** Free-form note on where/why this evidence applies. */
    note: z.string().max(2_000, 'A note must be at most 2000 characters').default(''),
  })
  .strict()
  // At minimum, a chapter OR a scene locator must be present.
  .refine((evidence) => Boolean(evidence.chapterId) || Boolean(evidence.sceneId), {
    message: 'Evidence must reference a chapter or a scene',
    path: ['chapterId'],
  });

export type Evidence = z.infer<typeof EvidenceSchema>;

/* -------------------------------------------------------------------------- */
/* Knowledge entries                                                          */
/* -------------------------------------------------------------------------- */

/** The kind of fact a knowledge entry represents. */
export const KNOWLEDGE_ENTRY_KINDS = [
  'character',
  'location',
  'faction',
  'rule',
  'event',
  'item',
  'concept',
  'term',
] as const;

export const KnowledgeEntryKindSchema = z.enum(KNOWLEDGE_ENTRY_KINDS);
export type KnowledgeEntryKind = z.infer<typeof KnowledgeEntryKindSchema>;

/**
 * Where an entry came from.
 *
 *   - `manual`      — authored directly in the Knowledge Base.
 *   - `character`   — indexed from an existing Character record.
 *   - `world`       — indexed from a World section / overview.
 *   - `chapter`     — indexed from an outline Chapter.
 *   - `scene`       — indexed from a Scene.
 *   - `narrative`   — indexed from the Narrative plan (logline/beats/foreshadowing).
 *
 * The `source` reference (below) carries the concrete entity id and a stable,
 * project-unique key so re-indexing the same entity is idempotent.
 */
export const KNOWLEDGE_SOURCES = [
  'manual',
  'character',
  'world',
  'chapter',
  'scene',
  'narrative',
] as const;

export const KnowledgeSourceSchema = z.enum(KNOWLEDGE_SOURCES);
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

/**
 * A stable reference back to the entity an entry was indexed from.
 *
 * `key` is a deterministic, project-unique string (e.g. `character:char_123`,
 * `world:section:wsec_9`, `chapter:chap_4`). The Service uses it to make import
 * idempotent: importing the same source twice updates the existing entry rather
 * than creating a duplicate. `entityId`/`entityType` are the raw locator.
 */
export const KnowledgeSourceRefSchema = z
  .object({
    entityType: KnowledgeSourceSchema,
    entityId: z.string().min(1).nullable(),
    /** Stable dedupe key; null for purely manual entries with no origin. */
    key: z.string().min(1).nullable(),
  })
  .strict();

export type KnowledgeSourceRef = z.infer<typeof KnowledgeSourceRefSchema>;

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title is required')
  .max(200, 'Title must be at most 200 characters');

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/**
 * A single searchable knowledge entry.
 *
 * `searchText` is a derived, lower-cased concatenation of the searchable fields
 * (title + summary + body + tags). The Service recomputes it on every write so
 * it can never drift from the source fields — the same strategy P4 uses for a
 * draft's cached `plainText`.
 */
export const KnowledgeEntrySchema = z
  .object({
    /** Stable primary key, prefixed (`know_…`). */
    id: z.string().min(1, 'Knowledge entry id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Knowledge entry projectId is required'),

    kind: KnowledgeEntryKindSchema,
    title: titleSchema,
    /** One-line summary shown in lists. Empty allowed. */
    summary: z.string().max(1_000, 'Summary must be at most 1000 characters').default(''),
    /** Long-form body. Empty allowed. */
    body: z.string().max(40_000, 'Body must be at most 40000 characters').default(''),
    tags: stringListSchema,

    /** Where the entry originated (manual vs. indexed entity). */
    source: KnowledgeSourceSchema,
    /** Concrete reference back to the originating entity (null for manual). */
    sourceRef: KnowledgeSourceRefSchema,
    /**
     * Denormalised copy of `sourceRef.key`, kept top-level so Dexie can index it
     * via the compound `[projectId+sourceKey]` index used for idempotent imports.
     * Always mirrors `sourceRef.key` (the Service writes both together).
     */
    sourceKey: z.string().min(1).nullable().default(null),
    /** Optional structured evidence locating the fact in the manuscript. */
    evidence: z.array(EvidenceSchema).max(50).default([]),

    /** Derived searchable text (lower-cased). Recomputed by the Service. */
    searchText: z.string().max(60_000).default(''),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((entry) => entry.updatedAt >= entry.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

/**
 * Builds the canonical, deterministic source key for an indexed entity.
 *
 * The key is project-relative and unique per origin entity, so the Service can
 * find "the entry for this character/section/chapter" and update it instead of
 * inserting a duplicate. `subKey` disambiguates multiple entries from one source
 * (e.g. several world sections of the same world, or several beats in a plan).
 */
export function buildSourceKey(
  entityType: KnowledgeSource,
  entityId: string | null,
  subKey?: string,
): string | null {
  if (entityType === 'manual' || !entityId) return null;
  const base = `${entityType}:${entityId}`;
  return subKey ? `${base}:${subKey}` : base;
}

/**
 * Derives the lower-cased searchable text for an entry.
 *
 * Kept here (pure, side-effect free) so the Service and any tests share exactly
 * one implementation. Field order determines result order for deterministic
 * assertions.
 */
export function deriveSearchText(entry: {
  title: string;
  summary: string;
  body: string;
  tags: string[];
}): string {
  return [entry.title, entry.summary, entry.body, ...entry.tags]
    .join(' \n ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
