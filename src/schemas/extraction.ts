import { z } from 'zod';
import { DocumentEvidenceSchema, MAX_DOCUMENT_CHARS } from './document';
import { KNOWLEDGE_ENTRY_KINDS } from './knowledge';

/**
 * Information-extraction domain schemas (P8) — single source of truth.
 *
 * The import pipeline produces `ExtractionRecord`s: candidate pieces of story
 * information drawn from a parsed document, each traceable to precise source
 * locations and gated behind a review flow before it can ever be integrated
 * into project entities.
 *
 * Key rules (see P8 Batch-1 brief):
 *   - A single, UNIFIED `ExtractionRecord` type — we deliberately do NOT create
 *     separate Location/Faction/WorldRule/etc. business tables. `kind` classifies
 *     a record and maps to an existing project entity at integration time.
 *   - Every record carries at least one `DocumentEvidence` (offset-based).
 *   - `origin` explicitly distinguishes fact (stated in the text) / ai (model
 *     inference) / manual (user supplement). ALL origins pass through review —
 *     `fact` does NOT mean "verified truth", only "stated in the source".
 *   - `confidence` is advisory ONLY and never substitutes for human review.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Kinds & origins                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What an extraction record describes.
 *
 * The first eight reuse the Knowledge-Base vocabulary so integration can map
 * directly onto `KnowledgeEntry.kind` / `Character` / world sections. Two extra
 * kinds cover P8-only semantics:
 *   - `relationship` — a relationship between two entities (maps to a
 *                      continuity `relationship` fact at integration).
 *   - `style`        — a stylistic observation (stored as a knowledge concept).
 */
export const EXTRACTION_KINDS = [
  ...KNOWLEDGE_ENTRY_KINDS,
  'relationship',
  'style',
] as const;
export const ExtractionKindSchema = z.enum(EXTRACTION_KINDS);
export type ExtractionKind = z.infer<typeof ExtractionKindSchema>;

/**
 * Origin of an extracted record.
 *
 *   - `fact`   — stated directly in the source text (still needs review).
 *   - `ai`     — a model-generated candidate (may be wrong; always reviewed).
 *   - `manual` — a user-supplied supplement.
 */
export const EXTRACTION_ORIGINS = ['fact', 'ai', 'manual'] as const;
export const ExtractionOriginSchema = z.enum(EXTRACTION_ORIGINS);
export type ExtractionOrigin = z.infer<typeof ExtractionOriginSchema>;

/**
 * Review lifecycle of a record.
 *
 *   - `pending`   — awaiting review (every new record starts here).
 *   - `confirmed` — approved for integration.
 *   - `rejected`  — discarded; never integrated.
 *   - `merged`    — folded into an EXISTING project entity instead of creating
 *                   a new one (its `integration` metadata records the target).
 */
export const EXTRACTION_REVIEW_STATUSES = ['pending', 'confirmed', 'rejected', 'merged'] as const;
export const ExtractionReviewStatusSchema = z.enum(EXTRACTION_REVIEW_STATUSES);
export type ExtractionReviewStatus = z.infer<typeof ExtractionReviewStatusSchema>;

/* -------------------------------------------------------------------------- */
/* Integration metadata                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where confirmed records are integrated into the real project model.
 *
 * `not-applied` is the default; `applied` records the concrete target entity;
 * `conflict` means an existing entity differs and the user must decide (no
 * silent overwrite). `conflicts` lists the differing fields for the review UI.
 */
export const INTEGRATION_STATUSES = ['not-applied', 'applied', 'conflict'] as const;
export const IntegrationStatusSchema = z.enum(INTEGRATION_STATUSES);
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

export const INTEGRATION_TARGET_TYPES = [
  'character',
  'world-section',
  'knowledge-entry',
  'continuity-fact',
  'chapter',
  'scene',
] as const;
export const IntegrationTargetTypeSchema = z.enum(INTEGRATION_TARGET_TYPES);
export type IntegrationTargetType = z.infer<typeof IntegrationTargetTypeSchema>;

const IntegrationConflictSchema = z
  .object({
    field: z.string().min(1).max(120),
    existing: z.string().max(4_000),
    incoming: z.string().max(4_000),
  })
  .strict();

export type IntegrationConflict = z.infer<typeof IntegrationConflictSchema>;

/**
 * Per-field conflict resolution policy (P8 Batch 5 — field-level conflicts).
 *
 * When an incoming record disagrees with an existing entity field, the user
 * MUST choose what happens; nothing is silently overwritten:
 *
 *   - `keep-existing`   — preserve the entity's current value (report only).
 *   - `use-extracted`   — replace the field with the extracted value.
 *   - `fill-empty-only` — write the extracted value ONLY where the existing
 *                         value is empty (a no-op for a populated field).
 *
 * There is intentionally NO default that overwrites. A field without an
 * explicit choice resolves to `keep-existing`, so a missing decision can only
 * ever be conservative.
 */
export const CONFLICT_STRATEGIES = ['keep-existing', 'use-extracted', 'fill-empty-only'] as const;
export const ConflictStrategySchema = z.enum(CONFLICT_STRATEGIES);
export type ConflictStrategy = z.infer<typeof ConflictStrategySchema>;

/**
 * One applied conflict decision, recorded in the integration audit so the
 * resulting entity state is explainable after the fact.
 */
export const ConflictResolutionSchema = z
  .object({
    field: z.string().min(1).max(120),
    strategy: ConflictStrategySchema,
    /** The value the entity held BEFORE the write. */
    existing: z.string().max(4_000),
    /** The value proposed by the extraction. */
    incoming: z.string().max(4_000),
    /** What was actually persisted for this field. */
    outcome: z.string().max(4_000),
    /** True when the entity field actually changed. */
    changed: z.boolean(),
  })
  .strict();

export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;

export const ExtractionIntegrationSchema = z
  .object({
    status: IntegrationStatusSchema,
    appliedEntityType: IntegrationTargetTypeSchema.optional(),
    appliedEntityId: z.string().min(1).optional(),
    conflicts: z.array(IntegrationConflictSchema).max(50).optional(),
    appliedAt: z.number().int().nonnegative().optional(),
    /**
     * Field-level conflict decisions applied at integration time (P8 Batch 5).
     * Additive + optional: records integrated before this field existed simply
     * omit it. Present on an applied record, it explains exactly how each
     * conflicting field was resolved (and what was stored).
     */
    resolutions: z.array(ConflictResolutionSchema).max(50).optional(),
  })
  .strict();

export type ExtractionIntegration = z.infer<typeof ExtractionIntegrationSchema>;

/* -------------------------------------------------------------------------- */
/* ExtractionRecord                                                           */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

const stringListSchema = z.array(z.string().trim().min(1).max(80)).max(50);

/* -------------------------------------------------------------------------- */
/* Merge audit trail (P8 Batch 4)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Audit trail recorded on a record that has been MERGED into another extraction
 * record (NOT into a project entity — that is Project Integration, a later phase).
 *
 * Merge folds a duplicate pending candidate ("source") into an existing one
 * ("target"). The SOURCE moves to `reviewStatus: 'merged'` and carries this
 * metadata so the merge is auditable and reversible in intent:
 *   - `targetId`      — the extraction id the source was folded into.
 *   - `mergedAt`      — when the merge happened.
 *   - `absorbedEvidence` — count of source evidence locators appended to the
 *                          target (informational; the target holds the real set).
 *
 * A merged record is terminal (never silently overwritten). Its evidence is
 * PRESERVED on the source record itself as well as appended to the target, so
 * provenance is never lost. This structure is additive: records that were never
 * merged simply omit the field.
 */
export const ExtractionMergeSchema = z
  .object({
    /** The extraction record this one was merged INTO. Never equal to its own id. */
    targetId: z.string().min(1, 'A merge target id is required'),
    /** When the merge was performed (epoch ms). */
    mergedAt: timestampSchema,
    /** How many source evidence locators were appended to the target. */
    absorbedEvidence: z.number().int().nonnegative(),
  })
  .strict();

export type ExtractionMerge = z.infer<typeof ExtractionMergeSchema>;

/**
 * Integration audit trail (P8 Batch 5).
 *
 * Written when a confirmed record is APPLIED, so every integrated entity is
 * traceable: which preview was applied, which field strategies the user chose,
 * the extraction/document fingerprints the decision was based on, and what each
 * conflict field resolved to. Additive + optional — records that were never
 * applied (or were applied by an older build) omit it.
 */
export const ExtractionIntegrationAuditSchema = z
  .object({
    /** The preview fingerprint the user explicitly confirmed. */
    previewFingerprint: z.string().min(1, 'An applied integration must carry its preview fingerprint').max(80),
    /** sha256 fingerprint of the extraction record at apply time. */
    recordFingerprint: z.string().min(1).max(80),
    /** sha256 of the source document raw text at apply time. */
    documentHash: z.string().min(1).max(80),
    /** The field strategies the user chose for this apply. */
    fieldStrategies: z.record(z.string(), ConflictStrategySchema),
    /** Per-field outcome of the conflict decisions. */
    resolutions: z.array(ConflictResolutionSchema).max(50),
    appliedAt: timestampSchema,
  })
  .strict();

export type ExtractionIntegrationAudit = z.infer<typeof ExtractionIntegrationAuditSchema>;

export const ExtractionRecordSchema = z
  .object({
    /** Stable primary key, prefixed (`ext_…`). */
    id: z.string().min(1, 'Extraction id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Extraction projectId is required'),
    /** Source document. Indexed with kind/review status. */
    documentId: z.string().min(1, 'Extraction documentId is required'),

    kind: ExtractionKindSchema,
    title: z
      .string()
      .trim()
      .min(1, 'Title is required')
      .max(200, 'Title must be at most 200 characters'),
    summary: z.string().max(1_000, 'Summary must be at most 1000 characters').default(''),
    body: z.string().max(40_000, 'Body must be at most 40000 characters').default(''),
    tags: stringListSchema,

    origin: ExtractionOriginSchema,
    /**
     * Advisory confidence in `[0, 1]`, or `null` when not applicable
     * (`fact`/`manual` typically have none). NEVER a substitute for review.
     */
    confidence: z
      .number()
      .min(0, 'Confidence must be at least 0')
      .max(1, 'Confidence must be at most 1')
      .nullable(),

    /**
     * Source locators. REQUIRED, non-empty: an extraction without a precise
     * document location cannot be persisted (mirrors P7's evidence rule).
     */
    evidence: z
      .array(DocumentEvidenceSchema)
      .min(1, 'An extraction must cite at least one document location')
      .max(50),

    /**
     * Idempotency key: a deterministic string that identifies "the same"
     * extraction so re-running extraction updates in place rather than
     * duplicating. Uniqueness is enforced at the DATABASE level by the compound
     * UNIQUE index `&[projectId+dedupeKey]` (Dexie v10), and additionally by the
     * importer's transactional "find-by-key → update-else-insert" upsert (which
     * turns a rare concurrent-insert race into an update instead of an error).
     */
    dedupeKey: z.string().min(1, 'A dedupe key is required').max(400),

    reviewStatus: ExtractionReviewStatusSchema,
    /** Ids of related entities (e.g. relationship targets). */
    relatedIds: z.array(z.string().min(1)).max(200).default([]),

    /** Where/whether this record has been integrated into project entities. */
    integration: ExtractionIntegrationSchema.default({ status: 'not-applied' }),

    /**
     * Merge audit trail (P8 Batch 4). Present IFF `reviewStatus === 'merged'`;
     * absent otherwise. Additive field — records never merged omit it entirely.
     */
    merge: ExtractionMergeSchema.optional(),

    /**
     * Integration audit trail (P8 Batch 5). Present IFF the record has been
     * integrated (`integration.status === 'applied'`); absent otherwise.
     * Additive field.
     */
    integrationAudit: ExtractionIntegrationAuditSchema.optional(),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((record) => record.updatedAt >= record.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  })
  // A merged record MUST carry its merge audit trail, and a non-merged record
  // MUST NOT (keeps the lifecycle invariant explicit and machine-checkable).
  .refine((record) => (record.reviewStatus === 'merged') === (record.merge !== undefined), {
    message: 'A `merge` audit trail is present if and only if reviewStatus is "merged"',
    path: ['merge'],
  })
  // A record can never be merged into itself.
  .refine((record) => record.merge === undefined || record.merge.targetId !== record.id, {
    message: 'An extraction cannot be merged into itself',
    path: ['merge', 'targetId'],
  });

export type ExtractionRecord = z.infer<typeof ExtractionRecordSchema>;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalises a string into a stable dedupe fragment: trimmed, lower-cased, and
 * whitespace-collapsed. Pure so importer and tests share one implementation.
 */
export function normaliseForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Builds the canonical idempotency key for an extraction record.
 *
 * The key is scoped to a document + kind + normalised title + normalised primary
 * section, so re-extracting the same fact from the same place yields the same
 * key (and the importer updates in place). It is intentionally independent of
 * origin/confidence so an AI and a fact extraction of the same thing collide and
 * can be reconciled by the user.
 */
export function buildDedupeKey(input: {
  documentId: string;
  kind: ExtractionKind;
  title: string;
  primarySectionId: string;
}): string {
  return [
    input.documentId,
    input.kind,
    normaliseForKey(input.title),
    input.primarySectionId,
  ].join('|');
}

/**
 * Guard so a helper never accidentally accepts more than the document limit.
 * Exposed for the importer to validate extracted bodies stay within bounds.
 */
export const MAX_EXTRACTION_BODY_CHARS = Math.min(40_000, MAX_DOCUMENT_CHARS);
