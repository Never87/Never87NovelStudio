import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { ChapterDraftSchema, DraftVersionSchema, SceneDraftSchema } from '@/schemas/manuscript';
import type { ChapterDraft, DraftVersion, SceneDraft } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for the manuscript tables (P4).
 *
 * Pure persistence only: every write and every read is validated against its
 * Zod schema, exactly like the other repositories. No business rules live here
 * (revision checks, snapshots and cascades belong to `ManuscriptService`).
 */
export class ManuscriptRepository {
  private readonly chapterDraftTable: Table<ChapterDraft, string>;
  private readonly sceneDraftTable: Table<SceneDraft, string>;
  private readonly versionTable: Table<DraftVersion, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.chapterDraftTable = database.chapterDrafts;
    this.sceneDraftTable = database.sceneDrafts;
    this.versionTable = database.draftVersions;
  }

  /* ---------------------------- Chapter drafts --------------------------- */

  /** The single manuscript of a chapter, or `null` when none was written yet. */
  async getChapterDraft(ownerId: string): Promise<ChapterDraft | null> {
    let row: ChapterDraft | undefined;
    try {
      row = await this.chapterDraftTable.where('ownerId').equals(ownerId).first();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read the draft of chapter "${ownerId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, ChapterDraftSchema, `Failed to read the draft of chapter "${ownerId}"`);
    return row;
  }

  async createChapterDraft(draft: ChapterDraft): Promise<ChapterDraft> {
    const validated = validate(draft, ChapterDraftSchema);
    try {
      await this.chapterDraftTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create the draft "${draft.id}"`, error);
    }
  }

  async putChapterDraft(draft: ChapterDraft): Promise<ChapterDraft> {
    const validated = validate(draft, ChapterDraftSchema);
    try {
      await this.chapterDraftTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save the draft "${draft.id}"`, error);
    }
  }

  /**
   * Atomically returns a chapter's manuscript, creating it when absent.
   *
   * `chapterDrafts` carries a UNIQUE `&ownerId` index, so a read-then-create
   * sequence is racy: two concurrent callers (React StrictMode double effect,
   * a double click, two tabs) both miss and both `add()` a *different* id for
   * the same chapter — the second write violates the unique index and the
   * editor fails to open. Checking and inserting inside ONE read-write Dexie
   * transaction makes the call idempotent: the loser of the race simply reads
   * back the row the winner committed instead of failing.
   *
   * The factory only runs when the row is genuinely missing, so id/timestamp
   * generation never happens for a draft that already exists.
   */
  async ensureChapterDraft(
    ownerId: string,
    factory: () => ChapterDraft,
  ): Promise<{ draft: ChapterDraft; created: boolean }> {
    try {
      return await getDb().transaction('rw', this.chapterDraftTable, async () => {
        const existing = await this.chapterDraftTable.where('ownerId').equals(ownerId).first();
        if (existing !== undefined) {
          assertReadable(
            existing,
            ChapterDraftSchema,
            `Failed to read the draft of chapter "${ownerId}"`,
          );
          return { draft: existing, created: false };
        }
        const validated = validate(factory(), ChapterDraftSchema);
        await this.chapterDraftTable.add(validated);
        return { draft: validated, created: true };
      });
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to create the draft of chapter "${ownerId}"`,
        error,
      );
    }
  }

  /** Reads a chapter draft by its own record id (used by version restore). */
  async getChapterDraftById(draftId: string): Promise<ChapterDraft | null> {
    let row: ChapterDraft | undefined;
    try {
      row = await this.chapterDraftTable.get(draftId);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read the draft record "${draftId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, ChapterDraftSchema, `Failed to read the draft record "${draftId}"`);
    return row;
  }

  /* ----------------------------- Scene drafts ---------------------------- */

  /** Reads a scene draft by its own record id (used by version restore). */
  async getSceneDraftById(draftId: string): Promise<SceneDraft | null> {
    let row: SceneDraft | undefined;
    try {
      row = await this.sceneDraftTable.get(draftId);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read the draft record "${draftId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, SceneDraftSchema, `Failed to read the draft record "${draftId}"`);
    return row;
  }

  async getSceneDraft(ownerId: string): Promise<SceneDraft | null> {
    let row: SceneDraft | undefined;
    try {
      row = await this.sceneDraftTable.where('ownerId').equals(ownerId).first();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read the draft of scene "${ownerId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, SceneDraftSchema, `Failed to read the draft of scene "${ownerId}"`);
    return row;
  }

  async createSceneDraft(draft: SceneDraft): Promise<SceneDraft> {
    const validated = validate(draft, SceneDraftSchema);
    try {
      await this.sceneDraftTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create the draft "${draft.id}"`, error);
    }
  }

  async putSceneDraft(draft: SceneDraft): Promise<SceneDraft> {
    const validated = validate(draft, SceneDraftSchema);
    try {
      await this.sceneDraftTable.put(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to save the draft "${draft.id}"`, error);
    }
  }

  /**
   * Atomically returns a scene's manuscript, creating it when absent.
   *
   * Same contract and same unique-index reasoning as `ensureChapterDraft`:
   * `sceneDrafts` also carries a UNIQUE `&ownerId` index, so check and insert
   * must happen inside one read-write transaction to stay idempotent.
   */
  async ensureSceneDraft(
    ownerId: string,
    factory: () => SceneDraft,
  ): Promise<{ draft: SceneDraft; created: boolean }> {
    try {
      return await getDb().transaction('rw', this.sceneDraftTable, async () => {
        const existing = await this.sceneDraftTable.where('ownerId').equals(ownerId).first();
        if (existing !== undefined) {
          assertReadable(
            existing,
            SceneDraftSchema,
            `Failed to read the draft of scene "${ownerId}"`,
          );
          return { draft: existing, created: false };
        }
        const validated = validate(factory(), SceneDraftSchema);
        await this.sceneDraftTable.add(validated);
        return { draft: validated, created: true };
      });
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create the draft of scene "${ownerId}"`, error);
    }
  }

  /* ------------------------------ Versions ------------------------------- */

  /** Reads one snapshot by its own id. */
  async getVersion(versionId: string): Promise<DraftVersion | null> {
    let row: DraftVersion | undefined;
    try {
      row = await this.versionTable.get(versionId);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read version "${versionId}"`, error);
    }
    if (row === undefined) return null;
    assertReadable(row, DraftVersionSchema, `Failed to read version "${versionId}"`);
    return row;
  }

  /** Every snapshot of one draft, newest revision first. */
  async listVersions(draftId: string): Promise<DraftVersion[]> {
    let rows: DraftVersion[];
    try {
      rows = await this.versionTable.where('draftId').equals(draftId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list versions of draft "${draftId}"`, error);
    }
    rows.forEach((row, index) =>
      assertReadable(row, DraftVersionSchema, `Failed to list versions (record at position ${index})`),
    );
    return rows.sort(compareVersions);
  }

  /**
   * Appends a snapshot.
   *
   * `bulkAdd` is used so a duplicate id fails loudly instead of silently
   * overwriting history — snapshots are immutable.
   */
  async addVersion(version: DraftVersion): Promise<DraftVersion> {
    const validated = validate(version, DraftVersionSchema);
    try {
      await this.versionTable.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to record a version of "${version.draftId}"`, error);
    }
  }

  async addVersions(versions: DraftVersion[]): Promise<void> {
    if (versions.length === 0) return;
    const validated = versions.map((version) => validate(version, DraftVersionSchema));
    try {
      await this.versionTable.bulkAdd(validated);
    } catch (error) {
      throw new ProjectRepositoryError('Failed to record manuscript versions', error);
    }
  }

  /**
   * Deletes the version history of several drafts at once.
   *
   * Used by the cascade paths: deleting drafts without their versions would
   * leave orphaned snapshots (they are keyed by draft id, so nothing else can
   * ever find or remove them).
   */
  async deleteVersionsByDraftIds(draftIds: string[]): Promise<number> {
    if (draftIds.length === 0) return 0;
    try {
      return await this.versionTable.where('draftId').anyOf(draftIds).delete();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to delete manuscript versions', error);
    }
  }

  async deleteVersionsByDraft(draftId: string, ids?: string[]): Promise<number> {
    try {
      if (ids && ids.length > 0) {
        return await this.versionTable.bulkDelete(ids).then(() => ids.length);
      }
      return await this.versionTable.where('draftId').equals(draftId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to prune versions of draft "${draftId}"`, error);
    }
  }

  /** Every chapter draft belonging to the given chapters. */
  async listChapterDraftsByOwnerIds(ownerIds: string[]): Promise<ChapterDraft[]> {
    if (ownerIds.length === 0) return [];
    try {
      return await this.chapterDraftTable.where('ownerId').anyOf(ownerIds).toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list chapter drafts', error);
    }
  }

  /** Every scene draft belonging to the given scenes. */
  async listSceneDraftsByOwnerIds(ownerIds: string[]): Promise<SceneDraft[]> {
    if (ownerIds.length === 0) return [];
    try {
      return await this.sceneDraftTable.where('ownerId').anyOf(ownerIds).toArray();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to list scene drafts', error);
    }
  }

  /* --------------------- Project-wide reads (P9 transfer) ----------------- */

  /**
   * Every chapter draft in a project, ordered by owner then id.
   *
   * Added for the P9 transfer layer: a project-wide export needs ALL drafts of a
   * project without first listing its chapters. Read-only and side-effect free.
   */
  async listChapterDraftsByProject(projectId: string): Promise<ChapterDraft[]> {
    try {
      const rows = await this.chapterDraftTable.where('projectId').equals(projectId).toArray();
      return rows.sort((a, b) => (a.ownerId === b.ownerId ? compareId(a.id, b.id) : compareId(a.ownerId, b.ownerId)));
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list chapter drafts of project "${projectId}"`, error);
    }
  }

  /** Every scene draft in a project, ordered by owner then id. */
  async listSceneDraftsByProject(projectId: string): Promise<SceneDraft[]> {
    try {
      const rows = await this.sceneDraftTable.where('projectId').equals(projectId).toArray();
      return rows.sort((a, b) => (a.ownerId === b.ownerId ? compareId(a.id, b.id) : compareId(a.ownerId, b.ownerId)));
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list scene drafts of project "${projectId}"`, error);
    }
  }

  /** Every version snapshot in a project, ordered by draft then revision. */
  async listVersionsByProject(projectId: string): Promise<DraftVersion[]> {
    try {
      const rows = await this.versionTable.where('projectId').equals(projectId).toArray();
      return rows.sort((a, b) =>
        a.draftId === b.draftId ? a.revision - b.revision || compareId(a.id, b.id) : compareId(a.draftId, b.draftId),
      );
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list versions of project "${projectId}"`, error);
    }
  }

  /* ------------------------------- Counts -------------------------------- */

  /** Sum of chapter-manuscript word counts in a project. */
  async countChapterDraftWords(projectId: string): Promise<number> {
    try {
      const rows = await this.chapterDraftTable.where('projectId').equals(projectId).toArray();
      return rows.reduce((sum, row) => sum + row.wordCount, 0);
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to count chapter words of project "${projectId}"`,
        error,
      );
    }
  }

  /** Sum of scene-manuscript word counts in a project. */
  async countSceneDraftWords(projectId: string): Promise<number> {
    try {
      const rows = await this.sceneDraftTable.where('projectId').equals(projectId).toArray();
      return rows.reduce((sum, row) => sum + row.wordCount, 0);
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to count scene words of project "${projectId}"`,
        error,
      );
    }
  }

  /* ------------------------------ Cascades ------------------------------- */

  /** Deletes every chapter draft of several chapters. Idempotent. */
  async deleteChapterDraftsByOwnerIds(ownerIds: string[]): Promise<number> {
    if (ownerIds.length === 0) return 0;
    try {
      return await this.chapterDraftTable.where('ownerId').anyOf(ownerIds).delete();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to delete chapter drafts', error);
    }
  }

  /** Deletes every scene draft of several scenes. Idempotent. */
  async deleteSceneDraftsByOwnerIds(ownerIds: string[]): Promise<number> {
    if (ownerIds.length === 0) return 0;
    try {
      return await this.sceneDraftTable.where('ownerId').anyOf(ownerIds).delete();
    } catch (error) {
      throw new ProjectRepositoryError('Failed to delete scene drafts', error);
    }
  }

  /** Deletes every chapter draft of a project. Idempotent. */
  async deleteChapterDraftsByProject(projectId: string): Promise<number> {
    try {
      return await this.chapterDraftTable.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete the chapter drafts of project "${projectId}"`,
        error,
      );
    }
  }

  /** Deletes every scene draft of a project. Idempotent. */
  async deleteSceneDraftsByProject(projectId: string): Promise<number> {
    try {
      return await this.sceneDraftTable.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete the scene drafts of project "${projectId}"`,
        error,
      );
    }
  }

  /** Deletes every version of a project. Idempotent. */
  async deleteVersionsByProject(projectId: string): Promise<number> {
    try {
      return await this.versionTable.where('projectId').equals(projectId).delete();
    } catch (error) {
      throw new ProjectRepositoryError(
        `Failed to delete the manuscript versions of project "${projectId}"`,
        error,
      );
    }
  }
}

/** Newest revision first; ties broken by creation time, then id. */
function compareVersions(a: DraftVersion, b: DraftVersion): number {
  if (a.revision !== b.revision) return b.revision - a.revision;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function validate<T>(value: T, schema: { safeParse: (v: unknown) => any }): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const id = String((value as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectValidationError(
      `Draft record "${id}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data as T;
}

function assertReadable<T>(value: T, schema: { safeParse: (v: unknown) => any }, context: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const id = String((value as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(
      `${context}: record "${id}" is malformed and was not returned`,
      result.error,
    );
  }
}

/** Deterministic id ordering helper (lexicographic by UTF-16 code unit). */
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
