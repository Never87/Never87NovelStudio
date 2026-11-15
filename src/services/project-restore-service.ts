import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import type { NovelProject, ProjectSnapshot } from '@/types';
import {
  TRANSFER_COLLECTIONS,
  type TransferCollection,
} from '@/transfer/collection-registry';
import {
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_SCHEMA_VERSION,
  type TransferProject,
} from '@/schemas/transfer';
import { computeIntegrity, verifyIntegrity } from '@/transfer/canonical-json';
import { validateTransferPackage } from '@/transfer/validation';
import { AmbiguousIdMapError } from '@/transfer/transfer-service';
import {
  buildIdMap,
  remapProject,
  defaultIdFactory,
  type IdFactory,
  type IdMap,
} from '@/transfer/id-mapping';
import { SnapshotService } from './snapshot-service';
import { ProjectService } from './project-service';
import { createProjectId } from '@/utils/id';
import { now } from '@/utils/date';

/**
 * Project Backup — RESTORE service (P9 Batch 4-3).
 *
 * The only place in the app that turns a validated `.n87novel` transfer package
 * INTO project data. It is a focused service boundary that REUSES the P9 B1
 * transfer foundation (parse/validate/integrity/id-remap) and the P9 B3
 * snapshot service (pre-restore safety snapshot). It never re-implements a
 * transfer format, never duplicates validation, and never touches B1–B3
 * schemas or semantics.
 *
 * ## Modes
 *
 *   - `restoreAsNewProject(entry)` — always allocates a FRESH project id (even
 *     if the source id is free), remaps every record/reference to fresh ids and
 *     INSERTS the whole project. The source project (if any) is untouched.
 *   - `replaceExistingProject(entry, targetProjectId)` — remaps the backup's
 *     root id to an EXPLICIT target id (never inferred), captures a pre-restore
 *     safety snapshot, then REPLACES the target's owned collections (rows only
 *     in the target are removed; backup rows are inserted). Other projects are
 *     never touched.
 *
 * ## Integrity, atomicity, isolation
 *
 *   - PRECHECK is pure: the payload is RE-VALIDATED (B1) and integrity is
 *     RECOMPUTED here — a stale/edited preview is never trusted as authorisation
 *     to write. All remapping and validation happen BEFORE the transaction.
 *   - WRITES happen in ONE `readwrite` Dexie transaction spanning `projects` +
 *     all 19 project-owned collections. Any failure rolls the WHOLE thing back:
 *     New mode leaves no partial project; Replace mode leaves the target
 *     byte-identical to its pre-transaction state.
 *   - `projectSnapshots` is NEVER in the transaction, so the target's snapshots
 *     (and the pre-restore safety snapshot) always survive a restore and a
 *     rollback.
 *   - Cross-project safety: inside the transaction we re-check existence and,
 *     defensively, that no remapped row's id is already owned by a DIFFERENT
 *     project — refusing rather than overwriting foreign data.
 *   - Secrets: the 19 collections never include the AI credential tables, so a
 *     restore can never import or restore an API key.
 *   - The imported entry is NEVER mutated: `remapProject` returns a deep copy.
 *
 * ## Editor coordination
 *
 * A Dexie transaction cannot synchronise React state. The UI MUST flush open
 * editors and reload after a restore; the service cannot do that for it. The
 * established app-wide coordination is: the restore broadcasts a
 * `PROJECT_RESTORED_EVENT`, and the autosave engine's optimistic-concurrency
 * check (`expectedRevision` → `DraftConflictError`) prevents a stale in-flight
 * autosave from resurrecting pre-restore content. See `RESTORE_UI_LIFECYCLE`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Stable machine-readable error codes for the restore layer. */
export const PROJECT_RESTORE_ERROR_CODES = [
  'invalid-payload',
  'integrity-failed',
  'id-collision',
  'ambiguous-ids',
  'target-not-found',
  'safety-snapshot-failed',
  'restore-failed',
] as const;

export type ProjectRestoreErrorCode = (typeof PROJECT_RESTORE_ERROR_CODES)[number];

/**
 * Where a restore failed. Lets a caller distinguish a rejected PRECHECK (nothing
 * was written), a failed SAFETY-snapshot capture (nothing was replaced), or a
 * failed RESTORE transaction (rolled back).
 */
export type ProjectRestorePhase = 'precheck' | 'safety-snapshot' | 'transaction';

/** The single error type raised by `ProjectRestoreService`. */
export class ProjectRestoreError extends Error {
  readonly code: ProjectRestoreErrorCode;
  readonly phase?: ProjectRestorePhase;
  readonly problems?: ReadonlyArray<{ code: string; message: string; path: string }>;

  constructor(
    code: ProjectRestoreErrorCode,
    message: string,
    options: {
      cause?: unknown;
      phase?: ProjectRestorePhase;
      problems?: ReadonlyArray<{ code: string; message: string; path: string }>;
    } = {},
  ) {
    super(message);
    this.name = 'ProjectRestoreError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.phase !== undefined) this.phase = options.phase;
    if (options.problems !== undefined) this.problems = options.problems;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API types                                                           */
/* -------------------------------------------------------------------------- */

/** Result of a successful restore, for both modes. */
export interface ProjectRestoreResult {
  /** Which mode produced this result. */
  readonly mode: 'new' | 'replace';
  /** The project row after the restore (newly created or replaced target). */
  readonly project: NovelProject;
  /** The id assigned to the project (fresh for `new`, the target for `replace`). */
  readonly projectId: string;
  /** Rows written per collection key. */
  readonly written: Readonly<Record<string, number>>;
  /**
   * Rows removed per collection key (always 0 for `new`; replace-only counts).
   */
  readonly removed: Readonly<Record<string, number>>;
  /**
   * The pre-restore safety snapshot (replace mode only). Present so the caller
   * can tell the user how to recover; `null` for new mode.
   */
  readonly safetySnapshot: ProjectSnapshot | null;
}

/** Options accepted by both restore modes. */
export interface ProjectRestoreOptions {
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly now?: number;
}

interface CollectionTable {
  readonly collection: TransferCollection;
  readonly table: Table<Record<string, unknown>, string>;
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export class ProjectRestoreService {
  private readonly db: NovelStudioDb;
  private readonly snapshots: SnapshotService;
  private readonly projects: ProjectService;
  private readonly makeProjectId: () => string;

  constructor(
    database: NovelStudioDb = getDb(),
    snapshots: SnapshotService = new SnapshotService(database),
    projects: ProjectService = new ProjectService(),
    makeProjectId: () => string = createProjectId,
  ) {
    this.db = database;
    this.snapshots = snapshots;
    this.projects = projects;
    this.makeProjectId = makeProjectId;
  }

  /* ---------------------------- Restore as new --------------------------- */

  /**
   * Restores a VALIDATED backup entry as a brand-new, independent project.
   *
   * A fresh project id is ALWAYS generated (the source id is never reused, even
   * if it is free), and the root id map is set to that id before remapping, so
   * every record, reference and ownership column is rewritten consistently.
   */
  async restoreAsNewProject(
    entry: TransferProject,
    options: ProjectRestoreOptions = {},
  ): Promise<ProjectRestoreResult> {
    const clock = options.now ?? now();
    const newProjectId = this.makeProjectId();

    // PRECHECK + remap (pure): re-validate the payload, build the id map with
    // the root overridden to the fresh id, remap, then RE-VALIDATE the result.
    const { remapped } = this.prepareRemappedEntry(entry, newProjectId, 'precheck');

    // A brand-new project gets a fresh identity: id, createdAt and updatedAt
    // are all newly owned (the source's timestamps are NOT carried over).
    const root: NovelProject = {
      ...remapped.project,
      id: newProjectId,
      createdAt: clock,
      updatedAt: clock,
    };
    const packageEntry: TransferProject = {
      project: root,
      data: remapped.data,
      integrity: computeIntegrity({ project: root, data: remapped.data }),
    };

    // WRITE: one atomic transaction. Insert the root and every owned row; no
    // deletes (nothing existing belongs to this fresh id).
    const written = await this.runInsertTransaction(packageEntry, newProjectId, 'precheck');

    const project = await this.readProject(newProjectId);
    return {
      mode: 'new',
      project,
      projectId: newProjectId,
      written,
      removed: emptyCounts(),
      safetySnapshot: null,
    };
  }

  /* --------------------------- Replace existing -------------------------- */

  /**
   * Replaces the owned collections of an EXPLICIT target project with a backup.
   *
   * The target is never inferred: the caller passes it. A pre-restore safety
   * snapshot is captured BEFORE any destructive write; if that snapshot cannot
   * be created the restore aborts with the target untouched.
   */
  async replaceExistingProject(
    entry: TransferProject,
    targetProjectId: string,
    options: ProjectRestoreOptions = {},
  ): Promise<ProjectRestoreResult> {
    const clock = options.now ?? now();

    // PRECHECK (no writes): validate payload, confirm the target exists, then
    // remap the root id to the target and re-validate.
    if (typeof targetProjectId !== 'string' || targetProjectId.trim() === '') {
      throw new ProjectRestoreError('target-not-found', 'No target project was selected.', {
        phase: 'precheck',
      });
    }
    const target = await this.requireTarget(targetProjectId);
    const { remapped } = this.prepareRemappedEntry(entry, targetProjectId, 'precheck');

    // Replace keeps the target's STABLE identity: id and createdAt are preserved
    // (B3 restore semantics); the rest of the root is taken from the backup.
    // `updatedAt` advances to reflect the change.
    const root: NovelProject = {
      ...remapped.project,
      id: target.id,
      createdAt: target.createdAt,
      updatedAt: clock,
    };
    const packageEntry: TransferProject = {
      project: root,
      data: remapped.data,
      integrity: computeIntegrity({ project: root, data: remapped.data }),
    };

    // SAFETY snapshot FIRST. If it fails, ABORT with nothing replaced.
    let safetySnapshot: ProjectSnapshot;
    try {
      safetySnapshot = await this.snapshots.createSnapshot(target.id, {
        label: `Before restore from backup of "${entry.project.title}"`,
        now: clock,
      });
    } catch (error) {
      throw new ProjectRestoreError(
        'safety-snapshot-failed',
        'The pre-restore safety snapshot could not be created, so the project was not changed.',
        { cause: error, phase: 'safety-snapshot' },
      );
    }

    // WRITE: one atomic replacement transaction. Any failure rolls back; the
    // safety snapshot (persisted outside the transaction) survives.
    let outcome: { written: Record<string, number>; removed: Record<string, number> };
    try {
      outcome = await this.runReplaceTransaction(packageEntry, target.id, target);
    } catch (error) {
      throw new ProjectRestoreError(
        'restore-failed',
        'The restore failed and was rolled back; the target project is unchanged and the pre-restore snapshot was kept.',
        { cause: error, phase: 'transaction' },
      );
    }

    const project = await this.readProject(target.id);
    return {
      mode: 'replace',
      project,
      projectId: target.id,
      written: outcome.written,
      removed: outcome.removed,
      safetySnapshot,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Preparation (pure; NO writes)                                            */
  /* ------------------------------------------------------------------------ */

  /**
   * Re-validates `entry`, remaps it onto `rootProjectId`, and re-validates the
   * remapped result. Returns a deep-copied, self-consistent entry. Never mutates
   * the input.
   */
  private prepareRemappedEntry(
    entry: TransferProject,
    rootProjectId: string,
    phase: ProjectRestorePhase,
  ): { remapped: TransferProject; idMap: IdMap } {
    if (typeof rootProjectId !== 'string' || rootProjectId.trim() === '') {
      throw new ProjectRestoreError('invalid-payload', 'A restore requires a non-empty project id.', { phase });
    }

    // (a) Re-validate the SOURCE payload BEFORE trusting it (a preview may be
    //     stale or the object may have been tampered with in memory).
    this.assertValidEntry(entry, 'The backup payload', phase);

    // (b) Build the id map, overriding ONLY the root project mapping so remap
    //     rewrites the root id and every ownership column consistently. All
    //     collections get fresh, collision-free ids.
    const rootOverrideFactory: IdFactory = (prefix) =>
      prefix === 'proj' ? rootProjectId : defaultIdFactory(prefix);
    let remappedEntry: TransferProject;
    let idMap: IdMap;
    try {
      idMap = buildIdMap(entry, rootOverrideFactory);
      const result = remapProject(entry, idMap);
      remappedEntry = result.project;
      // `remapProject` records a synthetic `projectId` "unresolved reference"
      // when the root id is UNCHANGED (it assumes a remap always renames the
      // root). In replace mode the target legitimately keeps its id, so that
      // marker is benign and must NOT be treated as a broken reference. Every
      // other unresolved entry is a genuine miss and is a real error.
      const genuineMisses = result.unresolvedReferences.filter((u) => u.field !== 'projectId');
      if (genuineMisses.length > 0) {
        // A reference with no mapping would survive as a stale id and be caught
        // by validation below; surface it early with the exact paths.
        throw new ProjectRestoreError(
          'invalid-payload',
          'The backup contains references that could not be remapped to the new ids.',
          {
            phase,
            problems: genuineMisses.slice(0, 25).map((u) => ({
              code: 'dangling-reference',
              message: `Reference "${u.field}" -> "${u.missingId}" on record "${u.recordId}" could not be remapped.`,
              path: `$.data.${u.collection}`,
            })),
          },
        );
      }
    } catch (error) {
      if (error instanceof ProjectRestoreError) throw error;
      if (error instanceof AmbiguousIdMapError) {
        throw new ProjectRestoreError(
          'ambiguous-ids',
          'The backup contains duplicate record ids, so it cannot be remapped safely.',
          { cause: error, phase },
        );
      }
      throw new ProjectRestoreError('invalid-payload', 'The backup could not be remapped for restore.', {
        cause: error,
        phase,
      });
    }

    // (c) RE-VALIDATE the REMAPPED result. This is the authoritative gate: the
    //     remapped package must pass the SAME B1 validation a fresh import would
    //     (references, ownership, offsets, integrity, …).
    this.assertValidEntry(remappedEntry, 'The remapped backup', phase);

    return { remapped: remappedEntry, idMap };
  }

  /**
   * Validates a single project entry by wrapping it in a one-project package and
   * running the B1 validator, then re-checking the integrity digest.
   *
   * Throws `invalid-payload` / `integrity-failed` with the exact B1 problems.
   */
  private assertValidEntry(entry: TransferProject, what: string, phase: ProjectRestorePhase): void {
    if (!entry || typeof entry !== 'object' || !entry.project || !entry.data) {
      throw new ProjectRestoreError('invalid-payload', `${what} is not a project entry.`, { phase });
    }
    // All 19 collections must be present as arrays (a TransferProject always has
    // them, but guard hand-built / remapped objects defensively).
    const missing = TRANSFER_COLLECTIONS.filter(
      (c) => !Array.isArray((entry.data as unknown as Record<string, unknown>)[c.key]),
    );
    if (missing.length > 0) {
      throw new ProjectRestoreError(
        'invalid-payload',
        `${what} is missing collections: ${missing.map((c) => c.key).join(', ')}.`,
        {
          phase,
          problems: missing.map((c) => ({
            code: 'schema-invalid',
            message: `Missing "${c.key}"`,
            path: `$.data.${c.key}`,
          })),
        },
      );
    }

    const wrapped = {
      format: TRANSFER_FORMAT,
      formatVersion: TRANSFER_FORMAT_VERSION,
      schemaVersion: TRANSFER_SCHEMA_VERSION,
      kind: 'project' as const,
      metadata: { exportedAt: 0, projectCount: 1 },
      projects: [entry],
    };
    const result = validateTransferPackage(wrapped);
    if (!result.valid) {
      throw new ProjectRestoreError('invalid-payload', `${what} failed validation and cannot be restored.`, {
        phase,
        problems: result.errors.map((p) => ({ code: p.code, message: p.message, path: p.path })),
      });
    }

    if (
      !verifyIntegrity(
        { project: entry.project, data: entry.data },
        entry.integrity,
      )
    ) {
      const recomputed = computeIntegrity({ project: entry.project, data: entry.data }).digest;
      throw new ProjectRestoreError(
        'integrity-failed',
        `${what} failed its integrity check (recomputed ${recomputed.slice(0, 12)}… != recorded ${entry.integrity.digest.slice(0, 12)}…).`,
        { phase },
      );
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Transactions                                                             */
  /* ------------------------------------------------------------------------ */

  /** Resolves the Dexie table handle for every project-owned collection. */
  private collectionTables(): CollectionTable[] {
    const db = this.db as unknown as Record<string, Table<Record<string, unknown>, string>>;
    return TRANSFER_COLLECTIONS.map((collection) => ({ collection, table: db[collection.table] }));
  }

  /** Deletes every row owned by `projectId` across all 19 collections. */
  private async assertNoForeignCollision(
    tables: CollectionTable[],
    entry: TransferProject,
    projectId: string,
  ): Promise<void> {
    for (const { collection, table } of tables) {
      const rows = entry.data[collection.key] as unknown as Array<Record<string, unknown>>;
      const ids = rows.map((r) => r.id).filter((id): id is string => typeof id === 'string');
      if (ids.length === 0) continue;
      const existing = await table.bulkGet(ids);
      for (const row of existing) {
        if (row && (row as Record<string, unknown>)[collection.ownerKey] !== projectId) {
          throw new ProjectRestoreError(
            'id-collision',
            `Collection "${collection.table}": record "${String((row as Record<string, unknown>).id)}" already belongs to another project; refusing to overwrite it.`,
          );
        }
      }
    }
  }

  /**
   * INSERT transaction for restore-as-new: root + all rows, no deletes.
   * Returns rows written per collection.
   */
  private async runInsertTransaction(
    entry: TransferProject,
    projectId: string,
    phase: ProjectRestorePhase,
  ): Promise<Record<string, number>> {
    const tables = this.collectionTables();
    const scope: Table<unknown, string>[] = [this.db.projects as unknown as Table<unknown, string>];
    const written: Record<string, number> = {};

    try {
      await this.db.transaction(
        'rw',
        scope.concat(tables.map((t) => t.table as unknown as Table<unknown, string>)),
        async () => {
          // Defensive: a fresh id must not already exist as a project, and no
          // remapped row may already be owned by a different project.
          const existingProject = await this.db.projects.get(projectId);
          if (existingProject !== undefined) {
            throw new ProjectRestoreError(
              'id-collision',
              `A project with id "${projectId}" already exists; refusing to create a duplicate.`,
              { phase },
            );
          }
          await this.assertNoForeignCollision(tables, entry, projectId);

          // Insert the ROOT first (children reference it), then each collection.
          await this.db.projects.put(entry.project);
          for (const { collection, table } of tables) {
            const rows = entry.data[collection.key] as unknown as Array<Record<string, unknown>>;
            if (rows.length > 0) await table.bulkPut(rows);
            written[collection.key] = rows.length;
          }
        },
      );
    } catch (error) {
      this.rethrowTransaction(error, phase);
    }
    return written;
  }

  /**
   * REPLACE transaction: root put + owner-scoped collection replacement, all in
   * ONE readwrite transaction over the root and all 19 collections.
   */
  private async runReplaceTransaction(
    entry: TransferProject,
    projectId: string,
    target: NovelProject,
  ): Promise<{ written: Record<string, number>; removed: Record<string, number> }> {
    const tables = this.collectionTables();
    const scope: Table<unknown, string>[] = [this.db.projects as unknown as Table<unknown, string>];
    const written: Record<string, number> = {};
    const removed: Record<string, number> = {};

    try {
      await this.db.transaction(
        'rw',
        scope.concat(tables.map((t) => t.table as unknown as Table<unknown, string>)),
        async () => {
          // Re-check the target INSIDE the transaction: it must still exist.
          const live = await this.db.projects.get(projectId);
          if (live === undefined) {
            throw new ProjectRestoreError(
              'target-not-found',
              `Project "${projectId}" disappeared before the restore could be applied.`,
            );
          }

          // Defensive: no remapped row may already be owned by a DIFFERENT
          // project (remapped ids are fresh, but never trust that blindly).
          await this.assertNoForeignCollision(tables, entry, projectId);

          // Replace the root: preserve stable identity (id + createdAt); take
          // the rest from the backup. The target row always exists here.
          await this.db.projects.put({ ...entry.project, id: projectId, createdAt: target.createdAt });

          // Per collection: delete ALL current target-owned rows, then insert
          // every (fresh-id) backup row. Every current row is "not in the
          // backup" because child ids are remapped to fresh ids.
          for (const { collection, table } of tables) {
            const rows = entry.data[collection.key] as unknown as Array<Record<string, unknown>>;
            const removedCount = await table
              .where(collection.ownerKey)
              .equals(projectId)
              .delete();
            if (rows.length > 0) await table.bulkPut(rows);
            removed[collection.key] = removedCount;
            written[collection.key] = rows.length;
          }
        },
      );
    } catch (error) {
      this.rethrowTransaction(error, 'transaction');
    }
    return { written, removed };
  }

  /** Preserves a typed restore error, wrapping any other failure with its cause. */
  private rethrowTransaction(error: unknown, phase: ProjectRestorePhase): never {
    if (error instanceof ProjectRestoreError) throw error;
    throw new ProjectRestoreError('restore-failed', 'The restore transaction failed and was rolled back.', {
      cause: error,
      phase,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Helpers                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Loads the target project or throws `target-not-found`. */
  private async requireTarget(projectId: string): Promise<NovelProject> {
    let target: NovelProject | null;
    try {
      target = await this.projects.getProject(projectId);
    } catch (error) {
      throw new ProjectRestoreError('restore-failed', `Failed to read project "${projectId}".`, {
        cause: error,
        phase: 'precheck',
      });
    }
    if (target === null) {
      throw new ProjectRestoreError('target-not-found', `Project "${projectId}" was not found.`, {
        phase: 'precheck',
      });
    }
    return target;
  }

  /** Reads the project row after a restore (best-effort, must exist). */
  private async readProject(projectId: string): Promise<NovelProject> {
    const project = await this.projects.getProject(projectId);
    if (project === null) {
      throw new ProjectRestoreError('restore-failed', `Project "${projectId}" could not be read after restore.`);
    }
    return project;
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle a restore UI MUST follow. Mirrors `RESTORE_UI_LIFECYCLE` (B3)
 * and is recorded here because a Dexie transaction cannot touch React state or
 * the autosave engine.
 */
export const BACKUP_RESTORE_UI_LIFECYCLE = {
  beforeRestore: [
    'Flush every open Chapter and Scene editor for the TARGET project so no debounced autosave is pending.',
    'Then run the restore; the service captures the pre-restore safety snapshot (replace mode) itself.',
  ],
  duringRestore: [
    'Await the service promise; do not mutate editor state while it is pending.',
    'Keep the action disabled to prevent duplicate submissions.',
  ],
  afterSuccess: [
    'Reload/refetch the project and every open editor document from the database.',
    'Broadcast PROJECT_RESTORED_EVENT so mounted consumers invalidate themselves.',
    'For replace mode, show that a pre-restore safety snapshot now exists.',
  ],
  afterFailure: [
    'The database is unchanged (the transaction rolled back); a reload is harmless.',
    'Surface the error code/phase. A safety-snapshot failure means nothing was replaced.',
  ],
} as const;

/** A fresh zeroed count map over all 19 collection keys. */
function emptyCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const collection of TRANSFER_COLLECTIONS) counts[collection.key] = 0;
  return counts;
}
