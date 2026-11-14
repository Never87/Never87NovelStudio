import { z } from 'zod';
import {
  AnalysisFindingSchema,
} from './analysis';
import { WorldSchema } from './world';
import { CharacterSchema } from './character';
import { NarrativePlanSchema } from './narrative';
import { ChapterSchema, VolumeSchema } from './outline';
import { SceneSchema } from './scene';
import {
  ChapterDraftSchema,
  DraftVersionSchema,
  SceneDraftSchema,
} from './manuscript';
import { PromptTemplateSchema } from './prompt';
import { PromptTemplateVersionSchema } from './prompt';
import { ContextConfigSchema, ContextItemSchema } from './context';
import { KnowledgeEntrySchema } from './knowledge';
import { ContinuityFactSchema } from './continuity';
import { NovelProjectSchema } from './project';
import { DocumentSectionSchema, SourceDocumentSchema } from './document';
import { ExtractionRecordSchema } from './extraction';

/**
 * Transfer-package schemas (P9 Batch 1) — single source of truth for the shape
 * of a portable, project-scoped data package.
 *
 * ## Purpose
 *
 * One versioned envelope is reused by every future transfer feature:
 *
 *   - Project Snapshots          (`.n87snapshot` later)
 *   - Project Import / Export    (`.n87novel`)
 *   - Workspace Backup / Restore (many projects in one file)
 *
 * This batch ships the FORMAT, VALIDATION and ID-MAPPING foundation only — no
 * UI, no import transaction, no persistence changes.
 *
 * ## Two distinct version numbers (do not conflate them)
 *
 *   - `formatVersion`  — the version of THIS envelope. Bumped only when the
 *                        envelope/record layout changes incompatibly.
 *   - `schemaVersion`  — the Dexie/domain schema version the package was
 *                        produced from (currently 12). Lets a future importer
 *                        decide whether it must migrate records on the way in.
 *
 * `schemaVersion` is INFORMATIONAL for now: the current importer never rewrites
 * rows, so it only reports a mismatch. It is captured explicitly rather than
 * inferred so a package is self-describing.
 *
 * ## Project-owned records only
 *
 * Every collection in `TransferProjectData` is a table whose rows carry a
 * `projectId`. Global workspace configuration (AI providers, models, task
 * assignments, the global default model) is DELIBERATELY ABSENT: those tables
 * hold API credentials and are not project data. See `src/transfer/` for the
 * secret-exclusion guarantees.
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Format identity & versions                                                 */
/* -------------------------------------------------------------------------- */

/** File-format identifier stored inside every package. */
export const TRANSFER_FORMAT = 'never87.novel-studio.transfer' as const;

/**
 * The transfer envelope version this build writes AND can read.
 *
 * A package declaring any other version is REJECTED (not silently coerced): a
 * future format may mean something different by the same field names.
 */
export const TRANSFER_FORMAT_VERSION = 1 as const;

/**
 * The Dexie schema version this build understands.
 *
 * Kept in sync manually with `src/db/database.ts`; asserted by the P9 tests so
 * the two can never drift unnoticed.
 *
 * NOTE (P9 B3-1): the DB schema was bumped to v13 to add the `projectSnapshots`
 * store. `projectSnapshots` is a project-owned table but is DELIBERATELY NOT a
 * transfer collection (a snapshot must never contain snapshots), so this carries
 * NO new `TransferProjectData` keys — it only advances the schema version a
 * package declares as "produced from".
 */
export const TRANSFER_SCHEMA_VERSION = 13 as const;

/** What a package is for. Recorded so a reader can refuse the wrong tool. */
export const TRANSFER_PACKAGE_KINDS = ['project', 'workspace'] as const;
export const TransferPackageKindSchema = z.enum(TRANSFER_PACKAGE_KINDS);
export type TransferPackageKind = z.infer<typeof TransferPackageKindSchema>;

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * Export metadata.
 *
 * Purely descriptive: it must never be needed to interpret the records. Nothing
 * here may contain credentials or user secrets.
 */
export const TransferMetadataSchema = z
  .object({
    /** When the package was produced (epoch ms). Informational. */
    exportedAt: timestampSchema,
    /** Application version string, when the caller knows it. */
    appVersion: z.string().trim().max(80).optional(),
    /** Free-form label (e.g. the project title at export time). */
    label: z.string().trim().max(200).optional(),
    /** How many projects the package carries (cross-checked by validation). */
    projectCount: z.number().int().nonnegative(),
  })
  .strict();

export type TransferMetadata = z.infer<typeof TransferMetadataSchema>;

/**
 * A stable fingerprint of a project's serialised content.
 *
 * Covers the project row and every owned record so a corrupted or edited
 * package can be detected without trusting the exporter. Computed over the
 * canonical JSON of the data (see `src/transfer/canonical-json.ts`), which sorts
 * object keys and preserves array order — so re-exporting identical data yields
 * an identical hash.
 */
export const TransferIntegritySchema = z
  .object({
    /** Hash algorithm tag. Only `sha256` is accepted. */
    algorithm: z.literal('sha256'),
    /** Lower-case hex digest of the canonical project JSON. */
    digest: z.string().regex(/^[0-9a-f]{64}$/, 'A digest must be 64 lower-case hex characters'),
  })
  .strict();

export type TransferIntegrity = z.infer<typeof TransferIntegritySchema>;

/* -------------------------------------------------------------------------- */
/* Project data blocks                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The records owned by ONE project, keyed by table.
 *
 * Every array is REQUIRED (never optional): an absent array would be an
 * easy way to silently drop a table, so a package must state `[]` explicitly.
 * The order of each array is the deterministic export order (see the exporter),
 * which is preserved verbatim so round-trips are byte-stable.
 *
 * The full ownership/relationship rules for each collection are documented on
 * `TRANSFER_COLLECTIONS` in `src/transfer/collection-registry.ts`.
 */
export const TransferProjectDataSchema = z
  .object({
    // --- P1–P3: project, world & planning -------------------------------
    /** Exactly one, matching the owning project's id. */
    worlds: z.array(WorldSchema).max(1, 'A project has exactly one world'),
    characters: z.array(CharacterSchema),
    /** Exactly one plan per project (optional: a project may have none yet). */
    narrativePlans: z.array(NarrativePlanSchema).max(1, 'A project has at most one narrative plan'),
    volumes: z.array(VolumeSchema),
    chapters: z.array(ChapterSchema),
    scenes: z.array(SceneSchema),

    // --- P4: manuscripts & version history ------------------------------
    chapterDrafts: z.array(ChapterDraftSchema),
    sceneDrafts: z.array(SceneDraftSchema),
    draftVersions: z.array(DraftVersionSchema),

    // --- P6: prompts & context ------------------------------------------
    promptTemplates: z.array(PromptTemplateSchema),
    promptTemplateVersions: z.array(PromptTemplateVersionSchema),
    contextItems: z.array(ContextItemSchema),
    /** At most one config per project. */
    contextConfigs: z.array(ContextConfigSchema).max(1, 'A project has at most one context config'),

    // --- P7: knowledge, continuity & analysis ---------------------------
    knowledgeEntries: z.array(KnowledgeEntrySchema),
    continuityFacts: z.array(ContinuityFactSchema),
    analysisFindings: z.array(AnalysisFindingSchema),

    // --- P8: import & extraction ----------------------------------------
    sourceDocuments: z.array(SourceDocumentSchema),
    documentSections: z.array(DocumentSectionSchema),
    extractionRecords: z.array(ExtractionRecordSchema),
  })
  .strict();

export type TransferProjectData = z.infer<typeof TransferProjectDataSchema>;

/** One project plus everything it owns. */
export const TransferProjectSchema = z
  .object({
    /** The project row itself (owned by nobody; the root of the tree). */
    project: NovelProjectSchema,
    /** Every record owned by this project, grouped by table. */
    data: TransferProjectDataSchema,
    /** Integrity digest over `{project, data}`. */
    integrity: TransferIntegritySchema,
  })
  .strict();

export type TransferProject = z.infer<typeof TransferProjectSchema>;

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The complete package written to disk / read back.
 *
 * `projects` always holds an array even for a single-project export: a
 * workspace backup is the same envelope with several entries, so both share one
 * reader, one validator and one ID-remapper.
 */
export const TransferPackageSchema = z
  .object({
    format: z.literal(TRANSFER_FORMAT),
    formatVersion: z.literal(TRANSFER_FORMAT_VERSION),
    schemaVersion: z.number().int().positive(),
    kind: TransferPackageKindSchema,
    metadata: TransferMetadataSchema,
    projects: z.array(TransferProjectSchema).min(1, 'A package must contain at least one project'),
  })
  .strict();

export type TransferPackage = z.infer<typeof TransferPackageSchema>;

/**
 * A version-agnostic pre-parse guard.
 *
 * The full package schema pins `formatVersion` to a literal, so a package from a
 * newer build would fail with a generic "invalid literal" message. This looser
 * schema reads ONLY the version fields first, letting the validator produce an
 * actionable "unsupported format version N (this build reads 1)" error instead.
 */
export const TransferPackageHeaderSchema = z
  .object({
    format: z.string(),
    formatVersion: z.number().int(),
    schemaVersion: z.number().int(),
    kind: z.string(),
  })
  .passthrough();

export type TransferPackageHeader = z.infer<typeof TransferPackageHeaderSchema>;
