import {
  TransferService,
  TransferSerializationError,
  type TransferPackage,
} from '@/transfer';
import { TransferRepositoryAdapter } from '@/transfer';
import type { NovelProject } from '@/types';

/**
 * Project Backup — file export service (P9 Batch 4-1).
 *
 * Produces a downloadable FILE backup of ONE project. It is a THIN layer over the
 * existing P9 B1 transfer foundation:
 *
 *   - serialisation  → `TransferService.exportProject(projectId)` + `serialize(pkg)`
 *   - validation     → the export self-validates; nothing is re-implemented here
 *   - integrity      → carried by B1 (sha256 over the canonical payload)
 *   - collections    → all 19 project-owned collections (B1 registry)
 *   - secrets        → never included (B1 guarantees it structurally)
 *
 * It adds ONLY the file-level concerns: a canonical JSON body, a safe file name
 * (`.n87novel`), a JSON MIME type, and display metadata for the UI. It does NOT
 * introduce a second backup format, does not touch the database for writes, and
 * does not support workspace export (Project only — see the B4 architecture
 * decision). Restoring a file is a LATER batch; this service only reads.
 *
 * The database reads go through `TransferRepositoryAdapter` → `TransferService`,
 * so file export reuses the EXACT code path that snapshots already trust.
 */

/** Default file extension for a project backup. */
export const PROJECT_BACKUP_EXTENSION = 'n87novel';
/** MIME type used for the downloadable backup file (it is canonical JSON). */
export const PROJECT_BACKUP_MIME = 'application/json;charset=utf-8';
/** Upper bound for the project-title segment of a file name (keeps names sane). */
const MAX_TITLE_SEGMENT = 80;

/** A ready-to-save project backup file plus the metadata a UI needs to show it. */
export interface ProjectBackupFile {
  /** The canonical JSON document (byte-stable; safe to download verbatim). */
  readonly content: string;
  /** A filesystem-safe file name ending in `.n87novel`. */
  readonly fileName: string;
  /** MIME type for the download Blob. */
  readonly mimeType: string;
  /** The exported project's id (== the source project id). */
  readonly projectId: string;
  /** The exported project's title (from the package, not the input). */
  readonly projectTitle: string;
  /** Number of rows per project-owned collection in the backup. */
  readonly counts: Readonly<Record<string, number>>;
  /** Total rows across all collections. */
  readonly totalRecords: number;
  /** Integrity digest of the serialised payload (carried from B1). */
  readonly integrityDigest: string;
  /** Export timestamp recorded in the package metadata (epoch ms). */
  readonly exportedAt: number;
}

/** Raised when a file backup cannot be produced. Preserves the cause. */
export class BackupServiceError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'BackupServiceError';
    this.cause = cause;
  }
}

/**
 * Sanitises an arbitrary project title into a safe file-name segment.
 *
 * - Removes path separators, control chars and characters illegal on Windows /
 *   POSIX file systems (`<>:"/\|?*` and NUL).
 * - Collapses runs of whitespace to single spaces and trims.
 * - Preserves Unicode (e.g. Chinese characters) so `我的小说` stays readable.
 * - Falls back to `project` when the result would be empty.
 */
export function sanitizeBackupFileNameSegment(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, MAX_TITLE_SEGMENT)
    .trim();
  return cleaned.length > 0 ? cleaned : 'project';
}

/** Builds the canonical backup file name: `<safe-title>.n87novel`. */
export function buildBackupFileName(title: string): string {
  return `${sanitizeBackupFileNameSegment(title)}.${PROJECT_BACKUP_EXTENSION}`;
}

/**
 * Backup service — file export of a single project.
 *
 * Pure-with-respect-to-writes: it only READS through the transfer layer. A
 * missing project throws the transfer layer's `TransferExportError`; any other
 * failure (including a self-validation failure) is re-thrown as
 * `BackupServiceError` with the original cause so a caller never reports a false
 * success.
 */
export class BackupService {
  private readonly transfer: TransferService;

  constructor(transfer: TransferService = new TransferService(new TransferRepositoryAdapter())) {
    this.transfer = transfer;
  }

  /**
   * Exports one project to an in-memory backup file.
   *
   * Steps: export (B1) → serialise (B1) → derive file metadata. All 19
   * collections are included and secrets are excluded by the transfer layer; the
   * produced package is self-validated before this method returns.
   */
  async exportProjectFile(projectId: string): Promise<ProjectBackupFile> {
    if (!projectId || projectId.trim() === '') {
      throw new BackupServiceError('A project id is required to create a backup.');
    }

    let pkg: TransferPackage;
    try {
      pkg = await this.transfer.exportProject(projectId);
    } catch (error) {
      // A missing project (or any export failure) surfaces as a real error; the
      // UI must NOT show success in this case.
      throw new BackupServiceError(
        error instanceof Error
          ? error.message
          : `Failed to export project "${projectId}" for backup.`,
        error,
      );
    }

    const entry = pkg.projects[0];
    if (!entry) {
      throw new BackupServiceError(`Export of project "${projectId}" produced no project entry.`);
    }

    let content: string;
    try {
      content = this.transfer.serialize(pkg);
    } catch (error) {
      const detail =
        error instanceof TransferSerializationError && error.problems.length > 0
          ? `: ${error.problems.map((p) => `${p.code}@${p.path}`).join(', ')}`
          : '';
      throw new BackupServiceError(
        `The backup for project "${projectId}" could not be serialised${detail}.`,
        error,
      );
    }

    const counts: Record<string, number> = {};
    for (const collection of Object.keys(entry.data)) {
      const rows = (entry.data as Record<string, unknown[]>)[collection];
      counts[collection] = Array.isArray(rows) ? rows.length : 0;
    }
    const totalRecords = Object.values(counts).reduce((sum, n) => sum + n, 0);

    const source: Pick<NovelProject, 'id' | 'title'> = entry.project;

    return {
      content,
      fileName: buildBackupFileName(source.title),
      mimeType: PROJECT_BACKUP_MIME,
      projectId: source.id,
      projectTitle: source.title,
      counts,
      totalRecords,
      integrityDigest: entry.integrity.digest,
      exportedAt: pkg.metadata.exportedAt,
    };
  }
}

/** Shared singleton (uses the default singleton `db` through the adapter). */
export const backupService = new BackupService();
