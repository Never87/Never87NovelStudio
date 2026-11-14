import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ProjectRepository } from '@/repositories/project-repository';
import { CharacterRepository } from '@/repositories/character-repository';
import { WorldRepository } from '@/repositories/world-repository';
import { NarrativeRepository } from '@/repositories/narrative-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { SceneRepository } from '@/repositories/scene-repository';
import { ManuscriptRepository } from '@/repositories/manuscript-repository';
import { PromptRepository } from '@/repositories/prompt-repository';
import { ContextRepository } from '@/repositories/context-repository';
import { KnowledgeRepository } from '@/repositories/knowledge-repository';
import { ContinuityRepository } from '@/repositories/continuity-repository';
import { AnalysisRepository } from '@/repositories/analysis-repository';
import { ImportRepository } from '@/repositories/import-repository';
import type { TransferProjectData } from '@/schemas/transfer';

/**
 * Read-only data adapter for the transfer layer (P9 Batch 1).
 *
 * ## Why an adapter at all?
 *
 * `TransferService` must stay UI-free AND database-agnostic so its serialisation
 * and validation can be tested without IndexedDB. This adapter is the ONE place
 * that knows about Dexie/repositories: it exposes a single
 * `readProjectData(projectId)` method returning every project-owned collection.
 *
 * ## Rules honoured
 *
 *   - READ ONLY. There is no write method; nothing in this batch can modify the
 *     database, and a future importer will get its own explicit write path.
 *   - Goes through the EXISTING repositories, so every row read has already been
 *     validated against its domain schema (repositories validate on read).
 *   - One `readonly` transaction-free read path: serialisation must never mutate
 *     state, and opening the DB lazily keeps import side-effect free.
 */

/** One complete read of a project's owned data. */
export interface ProjectDataSnapshot {
  readonly projectId: string;
  readonly data: TransferProjectData;
}

/**
 * Reads every project-owned collection for one project.
 *
 * Repositories are constructed with the injected database so tests can point at
 * an isolated instance; the default is the lazy app singleton.
 */
export class TransferRepositoryAdapter {
  private readonly db: NovelStudioDb;
  private readonly projects: ProjectRepository;
  private readonly worlds: WorldRepository;
  private readonly characters: CharacterRepository;
  private readonly narrative: NarrativeRepository;
  private readonly outline: OutlineRepository;
  private readonly scenes: SceneRepository;
  private readonly manuscript: ManuscriptRepository;
  private readonly prompts: PromptRepository;
  private readonly context: ContextRepository;
  private readonly knowledge: KnowledgeRepository;
  private readonly continuity: ContinuityRepository;
  private readonly analysis: AnalysisRepository;
  private readonly imports: ImportRepository;

  constructor(database: NovelStudioDb = getDb()) {
    this.db = database;
    this.projects = new ProjectRepository(database);
    this.worlds = new WorldRepository(database);
    this.characters = new CharacterRepository(database);
    this.narrative = new NarrativeRepository(database);
    this.outline = new OutlineRepository(database);
    this.scenes = new SceneRepository(database);
    this.manuscript = new ManuscriptRepository(database);
    this.prompts = new PromptRepository(database);
    this.context = new ContextRepository(database);
    this.knowledge = new KnowledgeRepository(database);
    this.continuity = new ContinuityRepository(database);
    this.analysis = new AnalysisRepository(database);
    this.imports = new ImportRepository(database);
  }

  /** The underlying database (exposed for diagnostics / transaction scoping). */
  getDatabase(): NovelStudioDb {
    return this.db;
  }

  /** All projects, newest `updatedAt` first (used by workspace-level tooling). */
  async listProjectIds(): Promise<string[]> {
    const projects = await this.projects.getAll();
    return projects.map((project) => project.id);
  }

  /**
   * Reads ALL project-owned records for `projectId`.
   *
   * Uses the repositories (not raw tables) so every row arrives validated. The
   * returned arrays are the deterministic export order: explicit `.sort()`
   * calls make the order independent of IndexedDB's natural ordering, which is
   * what makes the integrity digest reproducible across machines.
   */
  async readProjectData(projectId: string): Promise<TransferProjectData> {
    // Each collection is fetched below; promise batching keeps this to one
    // microtask round-trip per table without holding a long-lived transaction.
    const [
      world,
      characters,
      plan,
      volumes,
      chapters,
      scenes,
      chapterDrafts,
      sceneDrafts,
      draftVersions,
      promptTemplates,
      promptTemplateVersions,
      contextItems,
      contextConfig,
      knowledgeEntries,
      continuityFacts,
      analysisFindings,
      sourceDocuments,
      documentSections,
      extractionRecords,
    ] = await Promise.all([
      this.worlds.getByProjectId(projectId),
      this.characters.getByProjectId(projectId),
      this.narrative.getByProjectId(projectId),
      this.outline.listVolumes(projectId),
      this.outline.listChaptersByProject(projectId),
      this.scenes.listByProject(projectId),
      this.manuscript.listChapterDraftsByProject(projectId),
      this.manuscript.listSceneDraftsByProject(projectId),
      this.manuscript.listVersionsByProject(projectId),
      this.prompts.listByProject(projectId),
      this.prompts.listVersionsByProject(projectId),
      this.context.listByProject(projectId),
      this.context.getConfig(projectId),
      this.knowledge.getByProjectId(projectId),
      this.continuity.getByProjectId(projectId),
      this.analysis.getByProjectId(projectId),
      this.imports.listDocumentsByProject(projectId),
      this.imports.listSectionsByProject(projectId),
      this.imports.listExtractionsByProject(projectId),
    ]);

    return {
      worlds: world ? [world] : [],
      characters: byId(characters),
      narrativePlans: plan ? [plan] : [],
      volumes: byId(volumes),
      chapters: sortBy(chapters, (c) => [c.volumeId, c.order, c.id]),
      scenes: sortBy(scenes, (s) => [s.chapterId, s.order, s.id]),
      chapterDrafts: sortBy(chapterDrafts, (d) => [d.ownerId, d.id]),
      sceneDrafts: sortBy(sceneDrafts, (d) => [d.ownerId, d.id]),
      draftVersions: sortBy(draftVersions, (v) => [v.draftId, v.revision, v.id]),
      promptTemplates: sortBy(promptTemplates, (t) => [t.name, t.id]),
      promptTemplateVersions: sortBy(promptTemplateVersions, (v) => [v.templateId, v.version, v.id]),
      contextItems: sortBy(contextItems, (i) => [i.layer, i.id]),
      contextConfigs: contextConfig ? [contextConfig] : [],
      knowledgeEntries: sortBy(knowledgeEntries, (e) => [e.title, e.id]),
      continuityFacts: sortBy(continuityFacts, (f) => [f.anchorChapterId, f.anchorRank, f.createdAt, f.id]),
      analysisFindings: sortBy(analysisFindings, (f) => [f.category, f.createdAt, f.id]),
      sourceDocuments: sortBy(sourceDocuments, (d) => [d.createdAt, d.id]),
      documentSections: sortBy(documentSections, (s) => [s.documentId, s.order, s.id]),
      extractionRecords: sortBy(extractionRecords, (r) => [r.documentId, r.createdAt, r.id]),
    };
  }
}

/** Deterministic id ordering (lexicographic), never natural table order. */
function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Deterministic multi-key ordering.
 *
 * Compares each key in order; strings lexicographically, numbers numerically.
 * The final key is normally `id`, guaranteeing a total order even for ties.
 */
function sortBy<T>(rows: T[], keys: (row: T) => Array<string | number>): T[] {
  return [...rows].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < Math.min(ka.length, kb.length); i += 1) {
      const va = ka[i];
      const vb = kb[i];
      if (va === vb) continue;
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      const sa = String(va);
      const sb = String(vb);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    return 0;
  });
}
