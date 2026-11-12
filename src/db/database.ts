import Dexie, { type Table } from 'dexie';
import type {
  Chapter,
  ChapterDraft,
  Character,
  DraftVersion,
  NarrativePlan,
  NovelProject,
  Scene,
  SceneDraft,
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

