import { z } from 'zod';
import {
  KNOWLEDGE_ENTRY_KINDS,
  KnowledgeEntryKindSchema,
} from './knowledge';

/**
 * Chapter Analysis domain schemas (P11).
 *
 * A "chapter analysis" runs the AI entity-extraction pass over ONE chapter's
 * prose and turns the result into reviewable candidate entities + relationships.
 * Unlike the P8 document-extraction pipeline (which operates on imported
 * documents), this operates on the LIVE manuscript of a chapter.
 *
 * ## The three pillars this schema encodes
 *
 *   1. FINGERPRINTED, IDEMPOTENT RUNS. Each run records the exact
 *      `contentFingerprint` (sha256 of the chapter prose) it analysed. Re-running
 *      an UNCHANGED chapter is idempotent: the same fingerprint never produces a
 *      second run — the existing run is returned instead. Once the prose changes
 *      the fingerprint changes, so a fresh run is allowed and the old one is kept
 *      as HISTORY (provenance / re-analysis history).
 *   2. STABLE-ID RELATIONSHIPS. Candidate entities carry a `kind` + normalized
 *      `name`. Relationships reference entities by their NORMALIZED KEY (not by
 *      array index), so a relation survives a re-order and can be re-pointed to a
 *      stable project entity id once integrated.
 *   3. MANUAL-EDIT PROTECTION. Every candidate has a `reviewed` flag. Once the
 *      author edits/accepts/dismisses a candidate it is "reviewed" and a later
 *      re-analysis pass NEVER overwrites it (only brand-new candidates appear).
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Review lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/** Review status of a candidate entity produced by an analysis run. */
export const ANALYSIS_ENTITY_STATUSES = ['proposed', 'accepted', 'dismissed'] as const;
export const AnalysisEntityStatusSchema = z.enum(ANALYSIS_ENTITY_STATUSES);
export type AnalysisEntityStatus = z.infer<typeof AnalysisEntityStatusSchema>;

/**
 * REVIEW-TO-INTEGRATION lifecycle (distinct from the review status above).
 *
 * A candidate's REVIEW status (`status`) records the author's editorial
 * decision (proposed/accepted/dismissed). Its INTEGRATION status records whether
 * it has been resolved against / written into the canonical story model. The two
 * are deliberately SEPARATE: a candidate can be `accepted` (reviewed) but still
 * `pending` (not yet integrated), and only a canonical entity id makes it truly
 * integrated.
 *
 *   - `unreviewed` — never processed by the integration layer.
 *   - `pending`    — reviewed + accepted, awaiting integration (default stop).
 *   - `matched`    — linked to an EXISTING canonical entity (stable id recorded).
 *   - `created`    — a NEW canonical entity was created + linked.
 *   - `deferred`   — author chose to defer; no entity created/linked.
 *   - `uncertain`  — a possible/uncertain match is flagged for manual review.
 *   - `dismissed`  — the author dismissed the candidate at the integration step.
 */
export const ANALYSIS_INTEGRATION_STATUSES = [
  'unreviewed',
  'pending',
  'matched',
  'created',
  'deferred',
  'uncertain',
  'dismissed',
] as const;
export const AnalysisIntegrationStatusSchema = z.enum(ANALYSIS_INTEGRATION_STATUSES);
export type AnalysisIntegrationStatus = z.infer<typeof AnalysisIntegrationStatusSchema>;

/** The canonical entity family a candidate resolves to when integrated. */
export const ANALYSIS_CANONICAL_TYPES = ['character', 'world-section', 'knowledge-entry', 'none'] as const;
export const AnalysisCanonicalTypeSchema = z.enum(ANALYSIS_CANONICAL_TYPES);
export type AnalysisCanonicalType = z.infer<typeof AnalysisCanonicalTypeSchema>;

/** How an analysis run was produced. */
export const ANALYSIS_RUN_ORIGINS = ['ai', 'manual'] as const;
export const AnalysisRunOriginSchema = z.enum(ANALYSIS_RUN_ORIGINS);
export type AnalysisRunOrigin = z.infer<typeof AnalysisRunOriginSchema>;

/* -------------------------------------------------------------------------- */
/* Candidate entity + relationship                                            */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

const nameSchema = z
  .string()
  .trim()
  .min(1, 'A candidate name is required')
  .max(200, 'A candidate name must be at most 200 characters');

const evidenceSchema = z
  .object({
    /** Verbatim quote from the chapter prose (may be empty when not quoted). */
    quote: z.string().max(4_000).default(''),
    /**
     * Character offset into the chapter prose, when known. Kept for backward
     * compatibility with runs produced before evidence grounding; new runs use
     * the grounded `start`/`end` pair below.
     */
    offset: z.number().int().nonnegative().nullable().default(null),
    /**
     * Grounded start offset into the persisted chapter `content` (UTF-16, inclusive).
     * `null` when the passage could not be grounded (such evidence is not stored —
     * unsupported passages are dropped, not persisted with a fabricated offset).
     */
    start: z.number().int().nonnegative().nullable().default(null),
    /** Grounded end offset into the persisted chapter `content` (UTF-16, exclusive). */
    end: z.number().int().nonnegative().nullable().default(null),
    /**
     * True when `prose.slice(start, end) === quote` was verified against the
     * persisted source at extraction time. Always true for persisted evidence.
     */
    grounded: z.boolean().default(false),
    /** A short note explaining why this location supports the candidate. */
    note: z.string().max(2_000).default(''),
  })
  .strict()
  .refine((ev) => ev.start === null || ev.end === null || ev.end >= ev.start, {
    message: 'Evidence end must not be earlier than start',
    path: ['end'],
  });

export type AnalysisEvidence = z.infer<typeof evidenceSchema>;

/**
 * The integration state of one candidate. Additive + defaulted so every
 * pre-existing run (which had no integration concept) remains valid: the schema
 * treats a missing value as "unreviewed / not integrated".
 */
export const AnalysisIntegrationStateSchema = z
  .object({
    status: AnalysisIntegrationStatusSchema.default('unreviewed'),
    /** The canonical entity family this candidate was resolved to (or `none`). */
    canonicalType: AnalysisCanonicalTypeSchema.default('none'),
    /** The stable canonical entity id once a row was matched/created. */
    canonicalEntityId: z.string().min(1).nullable().default(null),
    /** How the match was made (`exact` | `alias` | `created` | `none`). */
    matchedBy: z.enum(['exact', 'alias', 'created', 'none']).default('none'),
    /**
     * When a POSSIBLE duplicate is suspected the closest existing entity id is
     * recorded here so the author can decide, without the candidate being merged.
     */
    possibleDuplicateId: z.string().min(1).nullable().default(null),
    /** A display label for the possible duplicate (convenience for the UI). */
    possibleDuplicateLabel: z.string().max(200).default(''),
    /** Epoch ms the integration decision was last made, or null. */
    decidedAt: timestampSchema.nullable().default(null),
  })
  .strict();

export type AnalysisIntegrationState = z.infer<typeof AnalysisIntegrationStateSchema>;

/**
 * A candidate entity extracted from a chapter.
 *
 * `key` is the STABLE relationship anchor: a normalized `${kind}:${normalizedName}`
 * string. Relationships reference these keys, so they stay valid across
 * re-ordering and can be re-pointed when the candidate is integrated into a real
 * project entity (whose id is then recorded in `linkedEntityId`).
 */
export const ChapterAnalysisEntitySchema = z
  .object({
    /** Stable relationship key: `${kind}:${normalizedName}` (lower-cased, trimmed). */
    key: z.string().min(1, 'A candidate key is required').max(260),
    /** Entity kind (drives which project entity an accepted candidate maps to). */
    kind: KnowledgeEntryKindSchema,
    /** Display name as the model proposed it (kept verbatim). */
    name: nameSchema,
    /** One-line description. Empty allowed. */
    summary: z.string().max(1_000).default(''),
    /** Longer notes / portrayal. Empty allowed. */
    detail: z.string().max(20_000).default(''),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    /** Review status; `proposed` until the author decides. */
    status: AnalysisEntityStatusSchema,
    /**
     * Once accepted and (optionally) integrated, the REAL project entity id this
     * candidate was linked to. `null` until integration. Its presence is what
     * makes relationships "stable" against the canonical entity, not a copy.
     */
    linkedEntityId: z.string().min(1).nullable().default(null),
    /** Supporting quotations from the chapter prose. */
    evidence: z.array(evidenceSchema).max(50).default([]),
    /**
     * Alternate names / aliases the model associated with this entity (e.g. a
     * title, nickname or shortened form). Used by the integration layer for
     * alias-aware matching against canonical entities; never overwrites data.
     */
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    /**
     * Review-to-integration state (distinct from `status`). Defaulted so a
     * pre-integration run validates unchanged.
     */
    integration: AnalysisIntegrationStateSchema.default({
      status: 'unreviewed',
      canonicalType: 'none',
      canonicalEntityId: null,
      matchedBy: 'none',
      possibleDuplicateId: null,
      possibleDuplicateLabel: '',
      decidedAt: null,
    }),
    /**
     * True once the author has reviewed this candidate (edited/accepted/
     * dismissed). A re-analysis NEVER mutates a reviewed candidate — this is the
     * manual-edit protection guarantee.
     */
    reviewed: z.boolean().default(false),
    /** Model confidence (advisory only) when AI-produced; `null` otherwise. */
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();

export type ChapterAnalysisEntity = z.infer<typeof ChapterAnalysisEntitySchema>;

/**
 * A relationship between two extracted candidates.
 *
 * Both endpoints are referenced by their stable candidate KEY, never by array
 * index, so re-ordering or filtering candidates can never corrupt a relation.
 */
export const ChapterAnalysisRelationshipSchema = z
  .object({
    /** Stable relationship id within the run (`rel_<n>` or a normalized key). */
    key: z.string().min(1).max(400),
    /** Short predicate, e.g. "mentors", "sister of", "located in". */
    relation: z.string().trim().min(1, 'A relation label is required').max(120),
    /** Source candidate key. */
    fromKey: z.string().min(1).max(260),
    /** Target candidate key. */
    toKey: z.string().min(1).max(260),
    /** One-line description. Empty allowed. */
    summary: z.string().max(1_000).default(''),
    /** Review status. */
    status: AnalysisEntityStatusSchema,
    /** Once integrated, the real project ids of the endpoints (when known). */
    linkedFromEntityId: z.string().min(1).nullable().default(null),
    linkedToEntityId: z.string().min(1).nullable().default(null),
    evidence: z.array(evidenceSchema).max(50).default([]),
    /**
     * Review-to-integration state (distinct from `status`). A relationship is
     * "integrated" once BOTH endpoints are linked to canonical entities; this
     * tracks that decision independently of the editorial review status.
     */
    integration: AnalysisIntegrationStateSchema.default({
      status: 'unreviewed',
      canonicalType: 'none',
      canonicalEntityId: null,
      matchedBy: 'none',
      possibleDuplicateId: null,
      possibleDuplicateLabel: '',
      decidedAt: null,
    }),
    reviewed: z.boolean().default(false),
    confidence: z.number().min(0).max(1).nullable().default(null),
  })
  .strict();

export type ChapterAnalysisRelationship = z.infer<typeof ChapterAnalysisRelationshipSchema>;

/* -------------------------------------------------------------------------- */
/* Analysis run                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A single analysis run over one chapter at one content fingerprint.
 *
 * Persisted so the author can review candidates across sessions and so the
 * re-analysis history is preserved (provenance). Excluded from the transfer
 * payload (it is derived, re-runnable metadata — see collection-registry) but
 * INCLUDED in the project-delete cascade.
 */
export const ChapterAnalysisRunSchema = z
  .object({
    /** Stable primary key, prefixed (`canls_…`). */
    id: z.string().min(1, 'An analysis run id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'An analysis run projectId is required'),
    /** The chapter this run analysed. */
    chapterId: z.string().min(1, 'An analysis run chapterId is required'),

    /**
     * sha256 of the chapter prose this run analysed, TAGGED (`sha256:<hex>`).
     * Two runs share a fingerprint iff the prose is byte-identical, which is the
     * idempotency key: re-running an unchanged chapter returns the existing run.
     */
    contentFingerprint: z.string().min(1, 'A content fingerprint is required'),

    origin: AnalysisRunOriginSchema,
    /** Provider/model that produced the candidates (for display + provenance). */
    modelTarget: z
      .object({
        providerName: z.string().default(''),
        modelName: z.string().default(''),
        modelId: z.string().default(''),
      })
      .strict()
      .nullable()
      .default(null),

    /** The extracted candidates for this run. */
    entities: z.array(ChapterAnalysisEntitySchema).max(500).default([]),
    /** Relationships between candidates, referenced by stable keys. */
    relationships: z.array(ChapterAnalysisRelationshipSchema).max(1_000).default([]),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((run) => run.updatedAt >= run.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  })
  .refine(
    (run) =>
      // Every relationship endpoint must reference a candidate that exists in
      // this run — enforced at the schema level so a dangling relation can never
      // be persisted.
      run.relationships.every(
        (rel) => run.entities.some((e) => e.key === rel.fromKey) && run.entities.some((e) => e.key === rel.toKey),
      ),
    {
      message: 'A relationship references an entity key that is not present in the run',
      path: ['relationships'],
    },
  );

export type ChapterAnalysisRun = z.infer<typeof ChapterAnalysisRunSchema>;

/* -------------------------------------------------------------------------- */
/* Pure helpers (shared by service + tests)                                   */
/* -------------------------------------------------------------------------- */

/** The set of entity kinds an analysis may propose. */
export const ANALYSIS_ENTITY_KINDS = KNOWLEDGE_ENTRY_KINDS;

/**
 * Normalizes a candidate name into the stable portion of its relationship key.
 *
 * Lower-cases, trims, collapses internal whitespace and strips surrounding
 * punctuation so `"Elara"`, `"elara"` and `" Elara "` all map to the same key
 * (`character:elara`). This is what makes relationship references stable across
 * cosmetic differences in how the model spelled the same entity.
 */
export function normalizeCandidateName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[«»"'`“”‘’.,;:!?()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Builds the stable relationship key `kind:normalizedName` for a candidate.
 *
 * Returned even for empty names (`kind:`) so callers can detect and reject an
 * empty name before building a candidate; the service validates the name first.
 */
export function buildEntityKey(kind: string, name: string): string {
  return `${kind}:${normalizeCandidateName(name)}`;
}
