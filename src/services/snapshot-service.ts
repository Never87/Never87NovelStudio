import { ZodError } from 'zod';
import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import type { NovelProject, ProjectSnapshot } from '@/types';
import {
  TRANSFER_COLLECTIONS,
  type TransferCollection,
} from '@/transfer/collection-registry';
import {
  TRANSFER_SCHEMA_VERSION,
  type TransferProject,
  type TransferProjectData,
} from '@/schemas/transfer';
import { computeIntegrity, verifyIntegrity } from '@/transfer/canonical-json';
import { validateTransferPackage } from '@/transfer/validation';
import {
  TransferRepositoryAdapter,
} from '@/transfer/transfer-repository-adapter';
import { TransferService, TransferSerializationError } from '@/transfer/transfer-service';
import { SnapshotRepository } from '@/repositories/snapshot-repository';
import { ProjectRepository, ProjectRepositoryError } from '@/repositories/project-repository';
import { createProjectSnapshotId } from '@/utils/id';
import { now } from '@/utils/date';

/**
 * Project Snapshots — business layer (P9 Batch 3-2).
 *
 * Captures a project's COMPLETE state as an immutable `ProjectSnapshot` (reusing
 * the P9 B1 transfer foundation) and performs a fully ATOMIC restore of a
 * snapshot back onto its project.
 *
 * ## Boundaries (deliberately NOT in this batch)
 *
 *   - No UI, no routes, no hooks, no editor/autosave coordination. This is a
 *     pure service. A future UI MUST flush the editors and reload project/editor
 *     state around `restoreSnapshot` — a Dexie transaction cannot synchronise
 *     React state on its own (see `RESTORE_UI_LIFECYCLE`).
 *   - No workspace backup, no file I/O, no publishing.
 *
 * ## Capture
 *
 * `createSnapshot` delegates serialisation to `TransferService.exportProject`,
 * which selects exactly the 19 project-owned collections and NEVER the AI
 * credential tables. It then re-validates the package and derives the
 * denormalised metadata (`counts`, `wordCount`, `integrity`, `projectTitle`)
 * FROM the payload so the columns can never disagree with the data. The
 * snapshot is persisted with a single `SnapshotRepository.create()` — there is
 * no half-written record on failure.
 *
 * ## Restore (atomic)
 *
 * All pure work (schema validation, integrity recomputation, reference checks,
 * id-set computation, owner-scoped row grouping) happens BEFORE the transaction.
 * The transaction is ONE `readwrite` Dexie transaction spanning `projects` plus
 * all 19 project-owned tables; any failure rolls the WHOLE thing back. The root
 * project id is preserved; other root fields are restored from the snapshot
 * (creation time kept immutable). `projectSnapshots` is NEVER part of the
 * transaction, so the target snapshot AND the pre-restore safety snapshot
 * always survive.
 *
 * ## Error model
 *
 * A single `SnapshotServiceError` carries a stable `code`
 * (`snapshot-not-found`, `project-not-found`, `project-mismatch`,
 * `integrity-failed`, `validation-failed`, `quota-exceeded`, `capture-failed`,
 * `restore-failed`) and preserves the original `cause`. Restore distinguishes
 * pre-check failure, safety-snapshot failure and transaction failure via
 * `phase`.
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Stable machine-readable error codes for the snapshot layer. */
export const SNAPSHOT_ERROR_CODES = [
  'snapshot-not-found',
  'project-not-found',
  'project-mismatch',
  'integrity-failed',
  'validation-failed',
  'quota-exceeded',
  'capture-failed',
  'restore-failed',
] as const;

export type SnapshotErrorCode = (typeof SNAPSHOT_ERROR_CODES)[number];

/**
 * Where a restore failed. Lets a caller distinguish a rejected PRE-CHECK (no
 * data was written), a failed SAFETY-snapshot capture (no restore attempted),
 * or a failed restore TRANSACTION (rolled back).
 */
export type SnapshotRestorePhase = 'precheck' | 'safety-snapshot' | 'transaction';

/** The single error type raised by `SnapshotService`. */
export class SnapshotServiceError extends Error {
  readonly code: SnapshotErrorCode;
  /** Restore phase, when the error occurred during a restore. */
  readonly phase?: SnapshotRestorePhase;
  /** Structural validation problems, when the error concerns validation. */
  readonly problems?: ReadonlyArray<{ code: string; message: string; path: string }>;

  constructor(
    code: SnapshotErrorCode,
    message: string,
    options: {
      cause?: unknown;
      phase?: SnapshotRestorePhase;
      problems?: ReadonlyArray<{ code: string; message: string; path: string }>;
    } = {},
  ) {
    super(message);
    this.name = 'SnapshotServiceError';
    this.code = code;
    if (options.cause !== undefined) this.cause = options.cause;
    if (options.phase !== undefined) this.phase = options.phase;
    if (options.problems !== undefined) this.problems = options.problems;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API types                                                           */
/* -------------------------------------------------------------------------- */

/** Options for `createSnapshot`. */
export interface CreateSnapshotOptions {
  /** Human-readable label. Empty/omitted → unnamed. */
  readonly label?: string;
  /**
   * Why the snapshot is captured. The service only ever sets `manual` or
   * `pre-restore` (the latter is used internally during restore).
   */
  readonly reason?: 'manual';
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly now?: number;
}

/** Result of a successful `restoreSnapshot`. */
export interface RestoreSnapshotResult {
  /** The snapshot that was restored. */
  readonly snapshot: ProjectSnapshot;
  /** The safety snapshot captured from the pre-restore state. */
  readonly safetySnapshot: ProjectSnapshot;
  /** The project row after restore. */
  readonly project: NovelProject;
  /** How many rows were removed per collection (0 for untouched collections). */
  readonly removed: Readonly<Record<string, number>>;
  /** How many rows were written per collection. */
  readonly written: Readonly<Record<string, number>>;
}

/**
 * The lifecycle a FUTURE restore UI MUST follow. Recorded here (not enforced by
 * the service) because the service cannot touch React state or the autosave
 * engine. Exported for documentation and B3-3.
 */
export const RESTORE_UI_LIFECYCLE = {
  beforeRestore: [
    'Flush every open editor (chapter + scene) so no debounced autosave is pending.',
    'Optionally prompt the user; the service already captures a pre-restore safety snapshot automatically.',
  ],
  duringRestore: [
    'Call projectSnapshotService.restoreSnapshot(snapshotId, projectId) and await it.',
    'Do NOT mutate editor state while the promise is pending.',
  ],
  afterSuccess: [
    'Rebind every AutosaveEngine to the restored revision/content (or reload the project).',
    'Reload the project and all open editor documents from the database.',
    'Refresh snapshot lists (a new pre-restore snapshot now exists).',
  ],
  afterFailure: [
    'The database is unchanged (the transaction rolled back). Reload is unnecessary but harmless.',
    'Surface the error code; pre-restore failure means nothing was restored.',
  ],
} as const;

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

/** A project-owned Dexie table handle, keyed by its collection. */
interface CollectionTable {
  readonly collection: TransferCollection;
  readonly table: Table<Record<string, unknown>, string>;
}

export class SnapshotService {
  private readonly db: NovelStudioDb;
  private readonly snapshots: SnapshotRepository;
  private readonly projects: ProjectRepository;
  private readonly transfer: TransferService;

  constructor(
    database: NovelStudioDb = getDb(),
    snapshots: SnapshotRepository = new SnapshotRepository(database),
    projects: ProjectRepository = new ProjectRepository(database),
    transfer: TransferService = new TransferService(new TransferRepositoryAdapter(database)),
  ) {
    this.db = database;
    this.snapshots = snapshots;
    this.projects = projects;
    this.transfer = transfer;
  }

  /* ------------------------------ Capture -------------------------------- */

  /**
   * Captures the COMPLETE current state of `projectId` as an immutable snapshot.
   *
   * All 19 project-owned collections are included; AI credential tables are
   * never serialised (guaranteed by the transfer layer). Metadata is derived
   * FROM the captured payload, so `counts`/`wordCount`/`integrity`/`projectTitle`
   * can never disagree with the data. A quota failure surfaces as
   * `quota-exceeded`; any other capture failure as `capture-failed`. On failure
   * nothing is persisted.
   */
  async createSnapshot(projectId: string, options: CreateSnapshotOptions = {}): Promise<ProjectSnapshot> {
    const capturedAt = options.now ?? now();

    // 1. Serialise the full project via the B1 transfer foundation. Export
    //    already re-validates the produced package and never includes secrets.
    const entry = await this.captureProjectEntry(projectId);

    // 2. Build the snapshot from the JUST-CAPTURED payload (single source of
    //    truth): every denormalised column is computed from `entry`.
    const snapshot = this.buildSnapshotRecord(entry, {
      label: options.label ?? '',
      reason: 'manual',
      createdAt: capturedAt,
    });

    // 3. Persist atomically via one add() — no half-written row on failure.
    try {
      return await this.snapshots.create(snapshot);
    } catch (error) {
      throw this.wrapCapture(error, `Failed to persist snapshot of project "${projectId}"`);
    }
  }

  /* ------------------------------- Reads --------------------------------- */

  /** Snapshots of `projectId`, newest first. Strictly project-scoped. */
  async listSnapshots(projectId: string): Promise<ProjectSnapshot[]> {
    try {
      return await this.snapshots.listByProject(projectId);
    } catch (error) {
      throw new SnapshotServiceError('restore-failed', `Failed to list snapshots of project "${projectId}"`, {
        cause: error,
      });
    }
  }

  /**
   * Reads one snapshot, verifying the caller's `projectId` owns it.
   *
   * Cross-project reads are refused with `project-mismatch`; a missing snapshot
   * is `snapshot-not-found`.
   */
  async getSnapshot(snapshotId: string, projectId: string): Promise<ProjectSnapshot> {
    const snapshot = await this.requireSnapshotOwnedBy(snapshotId, projectId, 'precheck');
    return snapshot;
  }

  /**
   * Deletes one snapshot after verifying ownership.
   *
   * Never touches project data or another project's snapshots. Idempotent for
   * the item itself, but ownership is still verified first so a caller cannot
   * delete another project's snapshot by guessing its id.
   */
  async deleteSnapshot(snapshotId: string, projectId: string): Promise<void> {
    await this.requireSnapshotOwnedBy(snapshotId, projectId, 'transaction');
    try {
      await this.snapshots.deleteById(snapshotId);
    } catch (error) {
      throw new SnapshotServiceError('restore-failed', `Failed to delete snapshot "${snapshotId}"`, {
        cause: error,
      });
    }
  }

  /* ------------------------------ Restore -------------------------------- */

  /**
   * Atomically restores `snapshotId` onto its project.
   *
   * ## Sequence
   *
   * 1. PRECHECK (no writes): snapshot exists, project exists, ownership matches,
   *    payload re-validates (schema + full transfer validation), integrity
   *    recomputes, all 19 collections present and correctly owned. Any failure
   *    throws with `phase: 'precheck'` BEFORE touching project data.
   * 2. SAFETY snapshot (`reason: 'pre-restore'`) of the CURRENT project state is
   *    captured and persisted. If this fails, the restore is ABORTED
   *    (`phase: 'safety-snapshot'`); project + target snapshot remain untouched.
   * 3. RESTORE TRANSACTION: one `readwrite` Dexie transaction over `projects`
   *    plus all 19 project-owned tables. Owner-aware replacement per collection,
   *    id-preserving. Root id preserved. Any error rolls the WHOLE thing back
   *    (`phase: 'transaction'`); the pre-restore snapshot and the target
   *    snapshot always survive because they are NOT in the transaction.
   */
  async restoreSnapshot(snapshotId: string, projectId: string): Promise<RestoreSnapshotResult> {
    // ---- 1. PRECHECK (pure; performs NO project writes) -------------------
    const snapshot = await this.requireSnapshotOwnedBy(snapshotId, projectId, 'precheck');
    const project = await this.requireProject(projectId, 'precheck');
    const entry = this.precheckSnapshotPayload(snapshot, projectId);

    // ---- 2. SAFETY snapshot of the CURRENT state --------------------------
    let safetySnapshot: ProjectSnapshot;
    try {
      const currentEntry = await this.captureProjectEntry(projectId);
      safetySnapshot = await this.snapshots.create(
        this.buildSnapshotRecord(currentEntry, {
          label: `Before restore of snapshot ${snapshotId}`,
          reason: 'pre-restore',
          createdAt: now(),
        }),
      );
    } catch (error) {
      // Nothing has been restored; project + target snapshot are intact.
      throw this.wrapCapture(error, `Failed to capture the safety snapshot before restoring "${snapshotId}"`, 'safety-snapshot');
    }

    // ---- 3. ATOMIC RESTORE TRANSACTION -----------------------------------
    let outcome: { removed: Record<string, number>; written: Record<string, number> };
    try {
      outcome = await this.runRestoreTransaction(projectId, project, entry);
    } catch (error) {
      // The transaction rolled back; safety + target snapshots remain.
      throw new SnapshotServiceError(
        'restore-failed',
        `Restoring snapshot "${snapshotId}" failed and was rolled back; the project is unchanged and the pre-restore snapshot was kept.`,
        { cause: error, phase: 'transaction' },
      );
    }

    const restoredProject = await this.readProjectForResult(projectId);

    return {
      snapshot,
      safetySnapshot,
      project: restoredProject,
      removed: outcome.removed,
      written: outcome.written,
    };
  }

  /* --------------------------- Transaction core -------------------------- */

  /**
   * Executes the restore inside ONE readwrite transaction over the root + all 19
   * collections. Pure computation (already done) is NOT repeated here — inside
   * the transaction we only perform owner-scoped IndexedDB operations.
   */
  private async runRestoreTransaction(
    projectId: string,
    currentProject: NovelProject,
    entry: TransferProject,
  ): Promise<{ removed: Record<string, number>; written: Record<string, number> }> {
    const tables = this.collectionTables();

    // Scope: the root project store + every project-owned table. DELIBERATELY
    // excludes `projectSnapshots` so neither the target nor the safety snapshot
    // can be cleared or overwritten by the restore.
    const scope: Table<unknown, string>[] = [this.db.projects as unknown as Table<unknown, string>];

    type Row = Record<string, unknown>;
    const data = entry.data;

    const result = await this.db.transaction(
      'rw',
      scope.concat(tables.map((t) => t.table as unknown as Table<unknown, string>)),
      async () => {
        // Guard (inside the tx): the restore must never touch another project's
        // rows. Since ids are global, a snapshot row whose id already exists
        // under a DIFFERENT project would be an integrity breach — refuse rather
        // than overwrite.
        for (const { collection, table } of tables) {
          const snapshotRows = data[collection.key] as unknown as Row[];
          const ids = snapshotRows.map((r) => r.id).filter((id): id is string => typeof id === 'string');
          if (ids.length === 0) continue;
          const existing = await table.bulkGet(ids);
          for (const row of existing) {
            if (row && (row as Row)[collection.ownerKey] !== projectId) {
              throw new Error(
                `Collection "${collection.table}": record "${String((row as Row).id)}" belongs to another project; refusing to overwrite.`,
              );
            }
          }
        }

        const removed: Record<string, number> = {};
        const written: Record<string, number> = {};

        // Restore the ROOT project first (children reference it). Preserve the
        // immutable creation time from the CURRENT row; take the rest from the
        // snapshot. The id is identical (project-mismatch is refused earlier).
        const restoredRoot: NovelProject = {
          ...entry.project,
          id: projectId,
          createdAt: currentProject.createdAt,
        };
        await this.db.projects.put(restoredRoot);

        // Replace each collection owner-scoped: delete current rows not present
        // in the snapshot, then put every snapshot row (id-preserving upsert).
        for (const { collection, table } of tables) {
          const snapshotRows = data[collection.key] as unknown as Row[];
          const snapshotIds = new Set(snapshotRows.map((r) => r.id).filter((id): id is string => typeof id === 'string'));

          const currentRows = (await table
            .where(collection.ownerKey)
            .equals(projectId)
            .toArray()) as Row[];

          const toDelete = currentRows
            .map((r) => r.id)
            .filter((id): id is string => typeof id === 'string' && !snapshotIds.has(id));

          if (toDelete.length > 0) await table.bulkDelete(toDelete);
          if (snapshotRows.length > 0) await table.bulkPut(snapshotRows as Array<Record<string, unknown>>);

          removed[collection.key] = toDelete.length;
          written[collection.key] = snapshotRows.length;
        }

        return { removed, written };
      },
    );

    return result;
  }

  /* ------------------------------ Precheck ------------------------------- */

  /**
   * Re-validates a snapshot's payload before any write. Returns the validated
   * `TransferProject` entry (with integrity re-verified against the data).
   *
   * Throws `phase: 'precheck'` errors: `validation-failed` for a malformed /
   * incomplete package, or `integrity-failed` when the digest no longer matches.
   */
  private precheckSnapshotPayload(snapshot: ProjectSnapshot, projectId: string): TransferProject {
    // (a) Fast ownership guard (already implied by the schema refine, but the
    //     snapshot may have been tampered with — never trust the column alone).
    if (snapshot.payload.project.id !== projectId) {
      throw new SnapshotServiceError(
        'project-mismatch',
        `Snapshot "${snapshot.id}" captures project "${snapshot.payload.project.id}", not "${projectId}".`,
        { phase: 'precheck' },
      );
    }

    // (b) Full transfer validation of the snapshot's payload wrapped as a
    //     one-project package. Reuses the SAME validator an import would use, so
    //     ownership, references, cardinality, offsets and integrity are all
    //     re-checked by one authoritative rule set.
    const wrapped = {
      format: 'never87.novel-studio.transfer',
      formatVersion: 1,
      schemaVersion: TRANSFER_SCHEMA_VERSION,
      kind: 'project' as const,
      metadata: { exportedAt: snapshot.createdAt, projectCount: 1 },
      projects: [snapshot.payload],
    };
    const result = validateTransferPackage(wrapped);
    if (!result.valid) {
      throw new SnapshotServiceError(
        'validation-failed',
        `Snapshot "${snapshot.id}" failed transfer validation and cannot be restored.`,
        {
          phase: 'precheck',
          problems: result.errors.map((p) => ({ code: p.code, message: p.message, path: p.path })),
        },
      );
    }

    // (c) Recompute the integrity digest from the records (do NOT trust the
    //     stored one). A mismatch means the payload was edited after capture.
    const recomputed = computeIntegrity({ project: snapshot.payload.project, data: snapshot.payload.data });
    if (!verifyIntegrity({ project: snapshot.payload.project, data: snapshot.payload.data }, snapshot.payload.integrity)) {
      throw new SnapshotServiceError(
        'integrity-failed',
        `Snapshot "${snapshot.id}" failed its integrity check (recomputed ${recomputed.digest.slice(0, 12)}… != stored ${snapshot.payload.integrity.digest.slice(0, 12)}…).`,
        { phase: 'precheck' },
      );
    }

    // (d) Every one of the 19 collections must be present as an array (a
    //     TransferProject always has all keys; this guards hand-built payloads
    //     that bypassed the schema's `.strict()` completeness by construction).
    const missing = TRANSFER_COLLECTIONS.filter((c) => !Array.isArray((snapshot.payload.data as TransferProjectData)[c.key]));
    if (missing.length > 0) {
      throw new SnapshotServiceError(
        'validation-failed',
        `Snapshot "${snapshot.id}" is missing collections: ${missing.map((c) => c.key).join(', ')}.`,
        { phase: 'precheck', problems: missing.map((c) => ({ code: 'schema-invalid', message: `Missing "${c.key}"`, path: `$.data.${c.key}` })) },
      );
    }

    return snapshot.payload;
  }

  /* ------------------------------ Helpers -------------------------------- */

  /** Serialises the full project via the transfer layer and validates it. */
  private async captureProjectEntry(projectId: string): Promise<TransferProject> {
    // Export already re-validates the produced package and throws on failure.
    let pkg;
    try {
      pkg = await this.transfer.exportProject(projectId);
    } catch (error) {
      // A missing project is a domain error, not a capture failure.
      if (this.isMissingProject(error)) {
        throw new SnapshotServiceError('project-not-found', `Project "${projectId}" was not found.`, {
          cause: error,
        });
      }
      throw this.wrapCapture(error, `Failed to capture project "${projectId}"`);
    }

    const entry = pkg.projects[0];
    if (!entry) {
      throw new SnapshotServiceError('capture-failed', `Export of project "${projectId}" produced no project entry.`);
    }
    return entry;
  }

  /**
   * Builds a fully-formed, schema-valid snapshot record FROM a captured entry.
   *
   * `counts`, `wordCount`, `projectTitle`, `integrity`, `schemaVersion` and
   * `formatVersion` are all derived from `entry`, guaranteeing metadata/payload
   * consistency. The repository's `create()` re-validates the whole record.
   */
  private buildSnapshotRecord(
    entry: TransferProject,
    meta: { label: string; reason: 'manual' | 'pre-restore'; createdAt: number },
  ): ProjectSnapshot {
    const counts: Record<string, number> = {};
    for (const collection of TRANSFER_COLLECTIONS) {
      counts[collection.key] = (entry.data[collection.key] as unknown[]).length;
    }
    const wordCount =
      entry.data.chapterDrafts.reduce((sum, d) => sum + d.wordCount, 0) +
      entry.data.sceneDrafts.reduce((sum, d) => sum + d.wordCount, 0);

    return {
      id: createProjectSnapshotId(),
      projectId: entry.project.id,
      label: meta.label,
      reason: meta.reason,
      createdAt: meta.createdAt,
      schemaVersion: TRANSFER_SCHEMA_VERSION,
      formatVersion: 1,
      projectTitle: entry.project.title,
      counts,
      wordCount,
      integrity: entry.integrity,
      payload: entry,
    };
  }

  /** Loads a snapshot and asserts it belongs to `projectId`. */
  private async requireSnapshotOwnedBy(
    snapshotId: string,
    projectId: string,
    phase: SnapshotRestorePhase,
  ): Promise<ProjectSnapshot> {
    let snapshot: ProjectSnapshot | null;
    try {
      snapshot = await this.snapshots.getById(snapshotId);
    } catch (error) {
      throw new SnapshotServiceError('restore-failed', `Failed to read snapshot "${snapshotId}".`, {
        cause: error,
        phase,
      });
    }
    if (snapshot === null) {
      throw new SnapshotServiceError('snapshot-not-found', `Snapshot "${snapshotId}" was not found.`, { phase });
    }
    if (snapshot.projectId !== projectId) {
      throw new SnapshotServiceError(
        'project-mismatch',
        `Snapshot "${snapshotId}" belongs to project "${snapshot.projectId}", not "${projectId}".`,
        { phase },
      );
    }
    return snapshot;
  }

  /** Loads the project or throws `project-not-found`. */
  private async requireProject(projectId: string, phase: SnapshotRestorePhase): Promise<NovelProject> {
    let project: NovelProject | null;
    try {
      project = await this.projects.getById(projectId);
    } catch (error) {
      throw new SnapshotServiceError('restore-failed', `Failed to read project "${projectId}".`, {
        cause: error,
        phase,
      });
    }
    if (project === null) {
      throw new SnapshotServiceError('project-not-found', `Project "${projectId}" was not found.`, { phase });
    }
    return project;
  }

  /** Reads the project row for the restore result (best-effort). */
  private async readProjectForResult(projectId: string): Promise<NovelProject> {
    const project = await this.projects.getById(projectId);
    if (project === null) {
      throw new SnapshotServiceError('project-not-found', `Project "${projectId}" disappeared during restore.`);
    }
    return project;
  }

  /** Resolves the Dexie table handle for every project-owned collection. */
  private collectionTables(): CollectionTable[] {
    const db = this.db as unknown as Record<string, Table<Record<string, unknown>, string>>;
    return TRANSFER_COLLECTIONS.map((collection) => ({
      collection,
      table: db[collection.table],
    }));
  }

  /* ------------------------------- Errors -------------------------------- */

  private isMissingProject(error: unknown): boolean {
    return error instanceof Error && /was not found/i.test(error.message);
  }

  /** Maps a capture failure to `quota-exceeded` / `capture-failed`, keeping cause. */
  private wrapCapture(error: unknown, message: string, phase?: SnapshotRestorePhase): SnapshotServiceError {
    if (error instanceof SnapshotServiceError) return error;
    if (isQuotaError(error)) {
      return new SnapshotServiceError(
        'quota-exceeded',
        `${message}: the browser storage quota was exceeded. Free space or reduce project size; no partial data was written.`,
        { cause: error, ...(phase ? { phase } : {}) },
      );
    }
    if (error instanceof TransferSerializationError) {
      return new SnapshotServiceError(
        'validation-failed',
        `${message}: the captured data failed transfer validation.`,
        { cause: error, ...(phase ? { phase } : {}), problems: error.problems.map((p) => ({ code: p.code, message: p.message, path: p.path })) },
      );
    }
    if (error instanceof ZodError) {
      return new SnapshotServiceError('validation-failed', message, { cause: error, ...(phase ? { phase } : {}) });
    }
    if (error instanceof ProjectRepositoryError) {
      return new SnapshotServiceError('capture-failed', message, { cause: error, ...(phase ? { phase } : {}) });
    }
    return new SnapshotServiceError('capture-failed', message, { cause: error, ...(phase ? { phase } : {}) });
  }
}

/**
 * Detects an IndexedDB storage-quota failure across browser implementations.
 *
 * Chrome/Edge report `QuotaExceededError` / `DOMException` with name
 * `QuotaExceededError` (legacy code 22) or `NS_ERROR_DOM_QUOTA_REACHED`
 * (Firefox); Safari may surface it via `AbortError` with a quota message. We
 * match on the DOMException name AND a message fallback.
 */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = 'name' in error ? String((error as { name?: unknown }).name) : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message) : '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  return /quota/i.test(message);
}
