import type {
  AnalysisFinding,
  Chapter,
  ChapterDraft,
  Character,
  ContextConfig,
  ContextItem,
  ContinuityFact,
  DocumentSection,
  DraftVersion,
  ExtractionRecord,
  KnowledgeEntry,
  NarrativePlan,
  PromptTemplate,
  PromptTemplateVersion,
  Scene,
  SceneDraft,
  SourceDocument,
  Volume,
  World,
} from '@/types';
import type { TransferProjectData } from '@/schemas/transfer';

/**
 * THE project-owned table inventory (P9 Batch 1).
 *
 * This registry is the single machine-readable answer to "what belongs to a
 * project?". Export, validation, integrity hashing and ID remapping all iterate
 * it, so a table can never be handled in one place and forgotten in another.
 *
 * ## How this list was derived
 *
 * It is NOT taken from an original entity list. It was produced by inspecting:
 *
 *   1. `src/db/database.ts` (schema v12) — every store with a `projectId`.
 *   2. `ProjectService.deleteProject` — the cascade list, which enumerates
 *      exactly the tables the application treats as project-owned.
 *   3. Every schema in `src/schemas/*.ts` that declares `projectId`.
 *
 * The two sources agree exactly (asserted by the P9 test suite), and `projects`
 * itself lives at `TransferProject.project` rather than inside `data`.
 *
 * ## Deliberately EXCLUDED (global workspace state)
 *
 *   - `aiProviders`  — holds `apiKey` and custom header values (credentials).
 *   - `aiModels`     — provider-bound model configuration, not project data.
 *   - `aiTaskConfigs`— which model each task uses (workspace-wide).
 *   - `aiGlobalConfig` — the workspace default model.
 *   - `projects`     — the root entity, carried separately.
 *
 * Excluding the AI tables is BOTH a scope decision (they are not project-owned,
 * so a project export must not carry them) AND the secret-exclusion guarantee
 * (a credential that is never selected can never be serialised). See
 * `SECRET_BEARING_TABLES` below.
 */

/** A table that holds a row collection inside `TransferProjectData`. */
export interface TransferCollection {
  /** Key inside `TransferProjectData`. */
  readonly key: keyof TransferProjectData;
  /** Dexie store name (used by repositories and diagnostics). */
  readonly table: string;
  /** The ownership column that must equal the root project id. */
  readonly ownerKey: 'id' | 'projectId';
  /**
   * Human-readable relationship rule. Surfaced verbatim in validation errors so
   * a broken reference explains itself without reading code.
   */
  readonly relationship: string;
  /**
   * Expected cardinality per project. `one` collections must appear exactly
   * once; `optional-one` at most once; `many` any number.
   */
  readonly cardinality: 'one' | 'optional-one' | 'many';
}

/**
 * Every project-owned collection, in a deterministic order.
 *
 * The order is parent-before-child wherever a reference exists, so a reader can
 * insert rows in this order without violating a foreign key.
 */
export const TRANSFER_COLLECTIONS: readonly TransferCollection[] = [
  {
    key: 'worlds',
    table: 'worlds',
    ownerKey: 'projectId',
    relationship: 'exactly one world per project (owned via projectId)',
    cardinality: 'optional-one',
  },
  {
    key: 'characters',
    table: 'characters',
    ownerKey: 'projectId',
    relationship: 'many characters per project (owned via projectId)',
    cardinality: 'many',
  },
  {
    key: 'narrativePlans',
    table: 'narrativePlans',
    ownerKey: 'projectId',
    relationship: 'at most one narrative plan per project (owned via projectId)',
    cardinality: 'optional-one',
  },
  {
    key: 'volumes',
    table: 'volumes',
    ownerKey: 'projectId',
    relationship: 'many volumes per project (owned via projectId)',
    cardinality: 'many',
  },
  {
    key: 'chapters',
    table: 'chapters',
    ownerKey: 'projectId',
    relationship: 'many chapters per project; chapter.volumeId must reference a packaged volume',
    cardinality: 'many',
  },
  {
    key: 'scenes',
    table: 'scenes',
    ownerKey: 'projectId',
    relationship: 'many scenes per project; scene.chapterId must reference a packaged chapter',
    cardinality: 'many',
  },
  {
    key: 'chapterDrafts',
    table: 'chapterDrafts',
    ownerKey: 'projectId',
    relationship: 'one chapter draft per chapter; draft.ownerId must reference a packaged chapter',
    cardinality: 'many',
  },
  {
    key: 'sceneDrafts',
    table: 'sceneDrafts',
    ownerKey: 'projectId',
    relationship: 'one scene draft per scene; draft.ownerId must reference a packaged scene',
    cardinality: 'many',
  },
  {
    key: 'draftVersions',
    table: 'draftVersions',
    ownerKey: 'projectId',
    relationship: 'many immutable version snapshots; version.draftId must reference a packaged draft',
    cardinality: 'many',
  },
  {
    key: 'promptTemplates',
    table: 'promptTemplates',
    ownerKey: 'projectId',
    relationship: 'many prompt templates per project (owned via projectId)',
    cardinality: 'many',
  },
  {
    key: 'promptTemplateVersions',
    table: 'promptTemplateVersions',
    ownerKey: 'projectId',
    relationship: 'many append-only template snapshots; version.templateId must reference a packaged template',
    cardinality: 'many',
  },
  {
    key: 'contextItems',
    table: 'contextItems',
    ownerKey: 'projectId',
    relationship: 'many context items per project (owned via projectId)',
    cardinality: 'many',
  },
  {
    key: 'contextConfigs',
    table: 'contextConfigs',
    ownerKey: 'projectId',
    relationship: 'at most one context config per project (owned via projectId)',
    cardinality: 'optional-one',
  },
  {
    key: 'knowledgeEntries',
    table: 'knowledgeEntries',
    ownerKey: 'projectId',
    relationship:
      'many knowledge entries per project; evidence references chapters/scenes/documents by id',
    cardinality: 'many',
  },
  {
    key: 'continuityFacts',
    table: 'continuityFacts',
    ownerKey: 'projectId',
    relationship:
      'many continuity facts per project; anchorChapterId must reference a packaged chapter',
    cardinality: 'many',
  },
  {
    key: 'analysisFindings',
    table: 'analysisFindings',
    ownerKey: 'projectId',
    relationship:
      'many analysis findings per project; evidence references chapters/scenes/documents by id',
    cardinality: 'many',
  },
  {
    key: 'sourceDocuments',
    table: 'sourceDocuments',
    ownerKey: 'projectId',
    relationship: 'many imported documents per project (owned via projectId)',
    cardinality: 'many',
  },
  {
    key: 'documentSections',
    table: 'documentSections',
    ownerKey: 'projectId',
    relationship:
      'many sections per project; section.documentId must reference a packaged document; section.parentId must reference a sibling section of the same document',
    cardinality: 'many',
  },
  {
    key: 'extractionRecords',
    table: 'extractionRecords',
    ownerKey: 'projectId',
    relationship:
      'many extraction records per project; documentId must reference a packaged document and every evidence locator must resolve to a packaged section',
    cardinality: 'many',
  },
] as const;

/** Every collection key, for exhaustive iteration. */
export const TRANSFER_COLLECTION_KEYS = TRANSFER_COLLECTIONS.map((c) => c.key);

/**
 * Tables that are NEVER included in a transfer package, with the reason.
 *
 * Recorded explicitly (and asserted in tests) so the exclusion is a documented
 * decision rather than an oversight.
 */
export const EXCLUDED_TABLES: ReadonlyArray<{ table: string; reason: string }> = [
  {
    table: 'projects',
    reason: 'Root entity — carried as TransferProject.project, not as a child collection.',
  },
  {
    table: 'aiProviders',
    reason: 'Holds API keys and custom header values (credentials). Never exported.',
  },
  {
    table: 'aiModels',
    reason: 'Workspace-level provider model configuration; not project-owned.',
  },
  {
    table: 'aiTaskConfigs',
    reason: 'Workspace-level task→model assignments; not project-owned.',
  },
  {
    table: 'aiGlobalConfig',
    reason: 'Workspace-level default model; not project-owned.',
  },
  {
    table: 'projectSnapshots',
    reason:
      'Project snapshots (P9 B3) are derived captures, not project data. A transfer ' +
      'package must never contain snapshots (a snapshot must not nest snapshots), so ' +
      'they are excluded even though rows are project-scoped.',
  },
];

/**
 * Tables that contain secret material. A package must never contain any of
 * these; the P9 tests scan every serialised package for them.
 */
export const SECRET_BEARING_TABLES: readonly string[] = ['aiProviders'];

/** Convenience: total number of project-owned collections. */
export const TRANSFER_COLLECTION_COUNT = TRANSFER_COLLECTIONS.length;

/**
 * Entity shape per collection, keyed by collection key.
 *
 * Used only to give the remapper a typed handle; it introduces no runtime
 * behaviour and duplicates no schema.
 */
export interface TransferCollectionEntities {
  worlds: World;
  characters: Character;
  narrativePlans: NarrativePlan;
  volumes: Volume;
  chapters: Chapter;
  scenes: Scene;
  chapterDrafts: ChapterDraft;
  sceneDrafts: SceneDraft;
  draftVersions: DraftVersion;
  promptTemplates: PromptTemplate;
  promptTemplateVersions: PromptTemplateVersion;
  contextItems: ContextItem;
  contextConfigs: ContextConfig;
  knowledgeEntries: KnowledgeEntry;
  continuityFacts: ContinuityFact;
  analysisFindings: AnalysisFinding;
  sourceDocuments: SourceDocument;
  documentSections: DocumentSection;
  extractionRecords: ExtractionRecord;
}
