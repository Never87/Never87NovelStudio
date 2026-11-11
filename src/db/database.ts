import Dexie, { type Table } from 'dexie';
import type { NovelProject } from '@/types';

/**
 * Novel Studio IndexedDB database.
 *
 * Only the `projects` table exists in P1-A. Sub-entities (Chapter, Character,
 * Scene, Location, …) are added in later phases — each carrying a `projectId`
 * index — through `version(2)`, `version(3)`, … migrations. Never by deleting
 * or recreating the database.
 *
 * Schemas are append-only: once shipped, a `version(n)` block is never edited.
 * To change indexes, add a new version block and let Dexie upgrade in place.
 */
export class NovelStudioDb extends Dexie {
  /** All novel projects. */
  projects!: Table<NovelProject, string>;

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
