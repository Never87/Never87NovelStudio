import Dexie, { type Table } from 'dexie';
import type {
  AiGlobalConfig,
  AiModel,
  AiProvider,
  AiTaskConfig,
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
  NovelProject,
  PromptTemplate,
  PromptTemplateVersion,
  Scene,
  SceneDraft,
  SourceDocument,
  Volume,
  World,
} from '@/types';

/**
 * Novel Studio IndexedDB database.
 *
 * Sub-entities are added phase by phase — each carrying a `projectId` index —
 * through `version(2)`, `version(3)`, … migrations. Never by deleting or
 * recreating the database.
 *
 * Schemas are append-only: once shipped, a `version(n)` block is never edited.
 * To change indexes, add a new version block and let Dexie upgrade in place.
 */
export class NovelStudioDb extends Dexie {
  /** All novel projects. */
  projects!: Table<NovelProject, string>;
  /** World/setting records — exactly one per project. */
  worlds!: Table<World, string>;
  /** Character records — many per project. */
  characters!: Table<Character, string>;
  /** Narrative plans — exactly one per project. */
  narrativePlans!: Table<NarrativePlan, string>;
  /** Outline volumes — many per project. */
  volumes!: Table<Volume, string>;
  /** Outline chapters — many per volume. */
  chapters!: Table<Chapter, string>;
  /** Scene designs — many per chapter. */
  scenes!: Table<Scene, string>;
  /** Chapter manuscripts (prose) — at most one per chapter (P4). */
  chapterDrafts!: Table<ChapterDraft, string>;
  /** Scene manuscripts (prose) — at most one per scene (P4). */
  sceneDrafts!: Table<SceneDraft, string>;
  /** Immutable manuscript snapshots — many per draft (P4). */
  draftVersions!: Table<DraftVersion, string>;
  /** AI provider configurations — global workspace settings (P5). */
  aiProviders!: Table<AiProvider, string>;
  /** AI models — many per provider (P5). */
  aiModels!: Table<AiModel, string>;
  /** Per-task model assignments — one row per AI task (P5). */
  aiTaskConfigs!: Table<AiTaskConfig, string>;
  /** Singleton row holding the global default model (P5). */
  aiGlobalConfig!: Table<AiGlobalConfig, string>;
  /** Prompt templates — current snapshot, per project (P6). */
  promptTemplates!: Table<PromptTemplate, string>;
  /** Immutable prompt-template version snapshots — append-only (P6, R1). */
  promptTemplateVersions!: Table<PromptTemplateVersion, string>;
  /** Persisted, user-controlled context items (references + notes) per project (P6). */
  contextItems!: Table<ContextItem, string>;
  /** Per-project context configuration — one row per project (P6). */
  contextConfigs!: Table<ContextConfig, string>;
  /** Searchable knowledge-base entries — many per project (P7). */
  knowledgeEntries!: Table<KnowledgeEntry, string>;
  /** Event-sourced continuity facts — many per project (P7). */
  continuityFacts!: Table<ContinuityFact, string>;
  /** Story-analysis findings — many per project (P7). */
  analysisFindings!: Table<AnalysisFinding, string>;
  /** Imported manuscripts (raw text kept verbatim) — many per project (P8). */
  sourceDocuments!: Table<SourceDocument, string>;
  /** Addressable parsed sections of a document — many per document (P8). */
  documentSections!: Table<DocumentSection, string>;
  /** Candidate extracted story information — many per document (P8). */
  extractionRecords!: Table<ExtractionRecord, string>;

  constructor(name = 'never87-novel-studio') {
    super(name);

    // v1 — projects only.
    //   &id        primary key (unique)
    //   title      index for lookups / prefix search
    //   status     index for filtering by lifecycle status
    //   createdAt  index for chronological ordering
    //   updatedAt  index for "recently edited" ordering
    this.version(1).stores({
      projects: '&id, title, status, createdAt, updatedAt',
    });

    // v2 — world building & characters (P2-A).
    //   worlds:     &id, &projectId  -> unique projectId enforces ONE world per project.
    //   characters: &id, projectId, name, createdAt, updatedAt
    //               -> projectId index lists a project's cast; name/createdAt/updatedAt
    //                  support ordering without a full table scan.
    //
    // This block only ADDS stores — the v1 `projects` schema is untouched, so
    // existing project records are preserved verbatim across the upgrade.
    this.version(2).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
    });

    // v3 — narrative planning (P2-B).
    //   narrativePlans: &id, &projectId, status, updatedAt
    //                   -> the unique projectId index enforces ONE plan per project,
    //                      exactly like the 1:1 world relationship in v2.
    //
    // Purely ADDITIVE: v1 `projects` and v2 `worlds`/`characters` schemas are
    // restated verbatim so their data survives the upgrade untouched.
    this.version(3).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
    });

    // v4 — outline & scene planning (P3).
    //   volumes:  &id, projectId, updatedAt
    //             -> lists a project's volumes without a full scan.
    //   chapters: &id, projectId, volumeId, [volumeId+order], status, updatedAt
    //             -> projectId for cascade deletes, volumeId (and the compound
    //                index) for ordered chapter trees, status for filtering.
    //   scenes:   &id, projectId, chapterId, [chapterId+order], status, updatedAt
    //             -> projectId for cascade deletes, chapterId for scene lists.
    //
    // Purely ADDITIVE: every earlier store is restated verbatim so v1-v3 data
    // (projects, worlds, characters, narrative plans) survives untouched.
    this.version(4).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
    });

    // v5 — writing editor (P4).
    //   chapterDrafts: &id, &ownerId, projectId, updatedAt
    //                  -> the UNIQUE ownerId index enforces one manuscript per
    //                     chapter, exactly like world->project and plan->project.
    //   sceneDrafts:   &id, &ownerId, projectId, updatedAt   (one per scene)
    //   draftVersions: &id, draftId, projectId, [draftId+revision], createdAt
    //                  -> draftId lists one draft's history; the compound index
    //                     orders it without a sort; projectId cascades on delete.
    //
    // Purely ADDITIVE: every v1-v4 store is restated verbatim so all existing
    // data (projects, worlds, characters, plans, volumes, chapters, scenes)
    // survives the upgrade untouched.
    this.version(5).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
    });

    // v6 — AI provider & model configuration (P5).
    //   aiProviders:    &id, providerType, enabled, updatedAt
    //                   -> listing/filtering providers; no projectId because
    //                      credentials are GLOBAL workspace settings, never
    //                      bound to a novel (see schemas/ai.ts).
    //   aiModels:       &id, providerId, [providerId+modelId], enabled
    //                   -> providerId lists a provider's models; the compound
    //                      [providerId+modelId] index backs duplicate checks.
    //   aiTaskConfigs:  &task
    //                   -> `task` is the primary key: exactly one row per AI
    //                      task, so a partial update touches a single record.
    //   aiGlobalConfig: &id
    //                   -> singleton (`id === 'global'`) holding the default model.
    //
    // Purely ADDITIVE: every v1-v5 store is restated verbatim so all existing
    // data (projects through manuscripts) survives the upgrade untouched.
    this.version(6).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
    });

    // v7 — Prompt Engineering Center & AI Context Manager (P6).
    //   promptTemplates:         &id, projectId, category, taskKind, updatedAt
    //                            -> projectId lists a project's templates; category
    //                               and taskKind back filtering and default lookup.
    //   promptTemplateVersions:  &id, templateId, projectId, [templateId+version], createdAt
    //                            -> append-only history; the compound index orders
    //                               a template's versions without a sort.
    //   contextItems:            &id, projectId, layer, updatedAt
    //                            -> projectId isolates context; layer groups by
    //                               the four-layer architecture.
    //   contextConfigs:          &id, &projectId, updatedAt
    //                            -> the UNIQUE projectId index enforces ONE config
    //                               per project, mirroring world/plan.
    //
    // Purely ADDITIVE: every v1-v6 store is restated verbatim so ALL existing
    // data (projects, planning, manuscripts, AI config) survives untouched.
    // The new AiModel.contextWindowTokens field is optional and needs no index,
    // so no data mutation is required by this migration.
    this.version(7).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
      promptTemplates: '&id, projectId, category, taskKind, updatedAt',
      promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
      contextItems: '&id, projectId, layer, updatedAt',
      contextConfigs: '&id, &projectId, updatedAt',
    });

    // v8 — Knowledge Base, Continuity & Story Analysis (P7).
    //   knowledgeEntries:  &id, projectId, kind, source, updatedAt, [projectId+sourceKey]
    //                      -> projectId lists a project's entries; kind/source back
    //                         filtering; the compound [projectId+sourceKey] index
    //                         backs the IDEMPOTENT import lookup (one entry per
    //                         origin entity per project). `sourceKey` is a
    //                         denormalised copy of `sourceRef.key` so it can be
    //                         indexed (Dexie cannot index a nested object field).
    //   continuityFacts:   &id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt
    //                      -> projectId isolates facts; the compound index groups a
    //                         chapter's facts for point-in-time reconstruction;
    //                         subjectId/predicate support per-subject queries.
    //   analysisFindings:  &id, projectId, category, status, updatedAt
    //                      -> projectId lists findings; category/status filter.
    //
    // Purely ADDITIVE: every v1-v7 store is restated verbatim so ALL existing
    // data (projects through P6 context) survives the upgrade untouched. The new
    // `sourceKey` field is denormalised by the P7 KnowledgeService on write and
    // needs no data mutation for pre-existing rows (there are none at v8).
    this.version(8).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
      promptTemplates: '&id, projectId, category, taskKind, updatedAt',
      promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
      contextItems: '&id, projectId, layer, updatedAt',
      contextConfigs: '&id, &projectId, updatedAt',
      knowledgeEntries: '&id, projectId, kind, source, updatedAt, [projectId+sourceKey]',
      continuityFacts: '&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt',
      analysisFindings: '&id, projectId, category, status, updatedAt',
    });

    // v9 — Import & Information Extraction, data foundation (P8).
    //   sourceDocuments:   &id, projectId, status, updatedAt
    //                      -> projectId isolates a project's imported documents;
    //                         status filters by pipeline stage.
    //   documentSections:  &id, projectId, documentId, [documentId+order], parentId
    //                      -> documentId lists a document's sections; the compound
    //                         [documentId+order] orders them without a sort;
    //                         parentId rebuilds the section tree; projectId cascades.
    //   extractionRecords: &id, projectId, documentId, kind, reviewStatus, updatedAt, [projectId+dedupeKey]
    //                      -> projectId isolates; kind/reviewStatus filter the review
    //                         UI; the compound [projectId+dedupeKey] backs the
    //                         idempotent lookup. NOTE: a Dexie non-unique index
    //                         cannot ENFORCE dedupe uniqueness — the importer runs
    //                         the "find-by-key-then-update-else-insert" logic inside
    //                         a single readwrite transaction so concurrent callers
    //                         cannot create duplicates.
    //
    // Purely ADDITIVE: every v1-v8 store is restated verbatim so ALL existing data
    // (projects through P7 analysis) survives the upgrade untouched. No data
    // mutation is required: the three new stores start empty.
    this.version(9).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
      promptTemplates: '&id, projectId, category, taskKind, updatedAt',
      promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
      contextItems: '&id, projectId, layer, updatedAt',
      contextConfigs: '&id, &projectId, updatedAt',
      knowledgeEntries: '&id, projectId, kind, source, updatedAt, [projectId+sourceKey]',
      continuityFacts: '&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt',
      analysisFindings: '&id, projectId, category, status, updatedAt',
      sourceDocuments: '&id, projectId, status, updatedAt',
      documentSections: '&id, projectId, documentId, [documentId+order], parentId',
      extractionRecords: '&id, projectId, documentId, kind, reviewStatus, updatedAt, [projectId+dedupeKey]',
    });

    // v10 — Database-level UNIQUE dedupe key for extraction records (P8 Batch 3
    // hardening).
    //   extractionRecords:  ... &[projectId+dedupeKey] ...
    //                      -> promotes the idempotency index from NON-unique to
    //                         UNIQUE. This makes "at most one extraction per
    //                         (project, dedupeKey)" a hard IndexedDB constraint:
    //                         a second `add()` of the same key now throws
    //                         ConstraintError at the DATABASE level, even for two
    //                         independent service instances, two tabs, or a stale
    //                         in-process lock. The service still performs its
    //                         find→update-else-insert inside a transaction (so the
    //                         common path is a clean upsert), but the schema is now
    //                         the backstop that guarantees no duplicate can ever
    //                         be committed. An existing duplicate (which the prior
    //                         transactional upsert prevented) would fail this
    //                         upgrade loudly rather than silently persist — the
    //                         desired fail-safe.
    //
    // Purely ADDITIVE and DATA-PRESERVING: every v1-v9 store is restated verbatim;
    // only the extractionRecords index line gains the `&` unique marker. No rows
    // are added, removed or mutated by the migration.
    this.version(10).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
      promptTemplates: '&id, projectId, category, taskKind, updatedAt',
      promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
      contextItems: '&id, projectId, layer, updatedAt',
      contextConfigs: '&id, &projectId, updatedAt',
      knowledgeEntries: '&id, projectId, kind, source, updatedAt, [projectId+sourceKey]',
      continuityFacts: '&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt',
      analysisFindings: '&id, projectId, category, status, updatedAt',
      sourceDocuments: '&id, projectId, status, updatedAt',
      documentSections: '&id, projectId, documentId, [documentId+order], parentId',
      extractionRecords: '&id, projectId, documentId, kind, reviewStatus, updatedAt, &[projectId+dedupeKey]',
    });

    // v11 — Extraction Review Center merge audit trail (P8 Batch 4).
    //   extractionRecords: unchanged INDEXES.
    //                      -> `ExtractionRecord` gains an OPTIONAL `merge`
    //                         sub-object ({targetId, mergedAt, absorbedEvidence}),
    //                         written only when a record is merged into another
    //                         extraction (reviewStatus 'merged'). Because it is a
    //                         nested object it CANNOT be indexed by Dexie and no
    //                         query needs to filter on it (the review UI reads the
    //                         whole record), so the schema/indexes are IDENTICAL to
    //                         v10. This block exists purely to document the
    //                         additive model change and to bump the DB version so
    //                         an existing browser upgrades (a no-op data-wise).
    //
    // Purely ADDITIVE and DATA-PRESERVING: every v1-v10 store is restated
    // verbatim; no index is added, removed or changed, and no row is mutated by
    // the migration. Records created before v11 simply omit `merge`, which the
    // schema treats as "not merged".
    this.version(11).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
      promptTemplates: '&id, projectId, category, taskKind, updatedAt',
      promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
      contextItems: '&id, projectId, layer, updatedAt',
      contextConfigs: '&id, &projectId, updatedAt',
      knowledgeEntries: '&id, projectId, kind, source, updatedAt, [projectId+sourceKey]',
      continuityFacts: '&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt',
      analysisFindings: '&id, projectId, category, status, updatedAt',
      sourceDocuments: '&id, projectId, status, updatedAt',
      documentSections: '&id, projectId, documentId, [documentId+order], parentId',
      extractionRecords: '&id, projectId, documentId, kind, reviewStatus, updatedAt, &[projectId+dedupeKey]',
    });

    // v12 — Project Integration audit + conflict resolutions (P8 Batch 5).
    //   extractionRecords: unchanged INDEXES.
    //                      -> `ExtractionRecord` gains two ADDITIVE optional
    //                         sub-objects:
    //                           - `integrationAudit`
    //                             {previewFingerprint, recordFingerprint,
    //                              documentHash, fieldStrategies, resolutions,
    //                              appliedAt} — written when a record is APPLIED
    //                             (integration.status === 'applied').
    //                           - `integration.resolutions`
    //                             [{field, strategy, existing, incoming,
    //                               outcome, changed}] — how each conflicting
    //                             field was resolved.
    //                         Both are nested objects, so they CANNOT be indexed
    //                         by Dexie and no query filters on them; the schema
    //                         is IDENTICAL to v11. This block documents the
    //                         additive model change and bumps the DB version so
    //                         an existing browser upgrades (a no-op data-wise).
    //
    // Purely ADDITIVE and DATA-PRESERVING: every v1-v11 store is restated
    // verbatim; no index is added, removed or changed, and no row is mutated by
    // the migration. Records created before v12 simply omit the new fields.
    this.version(12).stores({
      projects: '&id, title, status, createdAt, updatedAt',
      worlds: '&id, &projectId, updatedAt',
      characters: '&id, projectId, name, createdAt, updatedAt',
      narrativePlans: '&id, &projectId, status, updatedAt',
      volumes: '&id, projectId, updatedAt',
      chapters: '&id, projectId, volumeId, [volumeId+order], status, updatedAt',
      scenes: '&id, projectId, chapterId, [chapterId+order], status, updatedAt',
      chapterDrafts: '&id, &ownerId, projectId, updatedAt',
      sceneDrafts: '&id, &ownerId, projectId, updatedAt',
      draftVersions: '&id, draftId, projectId, [draftId+revision], createdAt',
      aiProviders: '&id, providerType, enabled, updatedAt',
      aiModels: '&id, providerId, [providerId+modelId], enabled',
      aiTaskConfigs: '&task',
      aiGlobalConfig: '&id',
      promptTemplates: '&id, projectId, category, taskKind, updatedAt',
      promptTemplateVersions: '&id, templateId, projectId, [templateId+version], createdAt',
      contextItems: '&id, projectId, layer, updatedAt',
      contextConfigs: '&id, &projectId, updatedAt',
      knowledgeEntries: '&id, projectId, kind, source, updatedAt, [projectId+sourceKey]',
      continuityFacts: '&id, projectId, [projectId+anchorChapterId], subjectId, predicate, updatedAt',
      analysisFindings: '&id, projectId, category, status, updatedAt',
      sourceDocuments: '&id, projectId, status, updatedAt',
      documentSections: '&id, projectId, documentId, [documentId+order], parentId',
      extractionRecords: '&id, projectId, documentId, kind, reviewStatus, updatedAt, &[projectId+dedupeKey]',
    });
  }
}

/**
 * Lazily-created singleton.
 *
 * The database is NOT opened at import time — importing this module performs
 * no I/O and no writes. Callers get a ready instance and call `open()`/queries
 * when they actually need data (the Repository layer, from P1-B onwards).
 * This keeps React modules free of side effects at import and avoids opening
 * IndexedDB during SSR/tests.
 */
let instance: NovelStudioDb | null = null;

/** Returns the one and only database instance, creating it on first call. */
export function getDb(): NovelStudioDb {
  if (!instance) {
    instance = new NovelStudioDb();
  }
  return instance;
}

