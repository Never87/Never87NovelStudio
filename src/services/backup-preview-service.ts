import {
  TransferService,
  TransferRepositoryAdapter,
  TRANSFER_COLLECTIONS,
  type TransferProblem,
  type TransferProject,
  type TransferValidationResult,
} from '@/transfer';
import { ProjectService } from './project-service';

/**
 * Project Backup — file IMPORT, parse & preview service (P9 Batch 4-2).
 *
 * A READ-ONLY layer over the P9 B1 transfer foundation that turns a user-selected
 * `.n87novel` backup into a typed, validated PREVIEW. It is deliberately a
 * SEPARATE service from the B4-1 export service (`backup-service.ts`):
 *
 *   - the export service produces a file; this one inspects one;
 *   - keeping them apart means neither grows a mixed "read/write" surface, and
 *     the read-only guarantee of the preview path is obvious from the file.
 *
 * ## What it reuses (nothing is re-implemented)
 *
 *   - parsing / JSON errors      → `TransferService.parse`
 *   - envelope & version checks  → B1 validation (`unsupported-format-version` …)
 *   - full schema validation     → B1 validation (existing domain schemas)
 *   - structural / reference /
 *     ownership / cardinality    → B1 validation
 *   - integrity digest           → B1 validation (`integrity-mismatch`)
 *   - collection inventory       → `TRANSFER_COLLECTIONS` (B1 registry)
 *
 * ## Guarantees
 *
 *   - READ ONLY: the ONLY database access is an existence probe
 *     (`ProjectService.projectExists`). No collection is written and nothing is
 *     migrated — a project is never created, overwritten or remapped.
 *   - REJECTS, never repairs: an invalid file throws a typed `BackupImportError`
 *     carrying the exact B1 problems. No normalisation, no ID remap, no partial
 *     acceptance.
 *   - NO WORKSPACE: a package whose `kind` is not `project` is rejected.
 *   - NO SECRETS: only the already-validated project payload is inspected; the
 *     B1 secret exclusion is untouched (credentials are never part of a project
 *     package, so they can never appear here).
 *   - NO RAW EXPOSURE: the raw payload is never retained, returned or logged; the
 *     preview carries only display metadata + per-collection counts.
 */

/**
 * Explicit, documented upper bound for an uploaded backup file.
 *
 * A single project's portable JSON is small even for very large novels; this cap
 * exists to reject an obviously-wrong selection (e.g. a binary/video file picked
 * by mistake) BEFORE the whole file is read into memory. It is a defensive limit,
 * not a claim that backups are expected to approach it. Chosen as 64 MiB.
 */
export const MAX_BACKUP_FILE_BYTES = 64 * 1024 * 1024;

/** Machine-readable reasons a backup file cannot be previewed. */
export type BackupImportErrorCode =
  | 'empty-input'
  | 'file-too-large'
  | 'invalid-json'
  | 'invalid-package'
  | 'wrong-package-kind'
  | 'unsupported-version'
  | 'integrity-mismatch';

/**
 * Typed error raised when a backup file cannot be parsed into a valid preview.
 *
 * `code` lets the UI offer targeted guidance. For a package-level rejection,
 * `problems` carries the UNCHANGED B1 validation problems so the precise reason
 * (missing collection, dangling reference, digest mismatch, …) is preserved.
 */
export class BackupImportError extends Error {
  readonly code: BackupImportErrorCode;
  readonly problems: readonly TransferProblem[];
  override readonly cause?: unknown;

  constructor(
    code: BackupImportErrorCode,
    message: string,
    options: { problems?: readonly TransferProblem[]; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'BackupImportError';
    this.code = code;
    this.problems = options.problems ?? [];
    this.cause = options.cause;
  }
}

/** Record count for one project-owned collection. */
export interface BackupCollectionCount {
  readonly key: string;
  readonly table: string;
  readonly count: number;
}

/**
 * A read-only preview of a backup file.
 *
 * Produced WITHOUT any database write and WITHOUT retaining the raw payload.
 * Nothing here implies a restore has happened.
 */
export interface BackupPreview {
  /** The selected file name (display only; never trusted as proof of validity). */
  readonly fileName: string;
  /** Size of the selected file's text in UTF-8 bytes. */
  readonly fileSizeBytes: number;
  /** Source project id, taken from the validated package (not the file name). */
  readonly projectId: string;
  /** Source project title, taken from the validated package. */
  readonly projectTitle: string;
  /** Package kind — always `project` once a preview is returned. */
  readonly kind: 'project';
  /** Envelope format version declared by the file. */
  readonly formatVersion: number;
  /** Domain schema version the file was produced from (informational). */
  readonly schemaVersion: number;
  /** App version recorded in metadata, when present. */
  readonly appVersion: string | null;
  /** Backup export timestamp (epoch ms) from the package metadata. */
  readonly exportedAt: number;
  /** The integrity digest carried by the package (verified by B1). */
  readonly integrityDigest: string;
  /** True: the digest was recomputed against the payload and matched. */
  readonly integrityVerified: true;
  /** All 19 project collection counts, in the canonical registry order. */
  readonly collections: readonly BackupCollectionCount[];
  /** Total records across all collections. */
  readonly totalRecords: number;
  /**
   * Whether a project with the source id ALREADY exists locally. This is a
   * READ-ONLY check and does NOT mean a restore has happened.
   */
  readonly sourceProjectExistsLocally: boolean;
  /** Restore-relevant warnings surfaced by B1 validation (never fabricated). */
  readonly warnings: readonly TransferProblem[];
}

/** Options for `previewBackupFile`. */
export interface PreviewBackupOptions {
  /** File name to display (display only). */
  readonly fileName?: string;
  /** Optional injectable existence probe (defaults to the real ProjectService). */
  readonly projectExists?: (projectId: string) => Promise<boolean>;
  /** Explicit size-limit override (defaults to `MAX_BACKUP_FILE_BYTES`). */
  readonly maxBytes?: number;
}

/** Accepts a File-like object OR its already-read text content. */
export type BackupPreviewInput = string | { text: string; name?: string };

/**
 * The validated single-project entry a restore consumes (P9 Batch 4-3).
 *
 * Returned by {@link BackupPreviewService.parseBackupEntry}. Unlike the
 * display-only {@link BackupPreview} (which carries only metadata + counts), this
 * yields the FULL validated {@link TransferProject} so the restore service can be
 * handed exactly what B1 validated — WITHOUT the preview view ever retaining or
 * exposing the raw payload.
 */
export interface ValidatedBackupEntry {
  /** The B1-validated single project entry (source ids intact; not remapped). */
  readonly entry: TransferProject;
  /** Restore-relevant warnings surfaced by B1 validation (never fabricated). */
  readonly warnings: readonly TransferProblem[];
}

/**
 * Parses a backup file into a read-only preview (P9 Batch 4-2).
 */
export class BackupPreviewService {
  private readonly transfer: TransferService;
  private readonly defaultProjectExists: (projectId: string) => Promise<boolean>;

  constructor(
    transfer: TransferService = new TransferService(new TransferRepositoryAdapter()),
    projectExists: (projectId: string) => Promise<boolean> = (id) =>
      new ProjectService().projectExists(id),
  ) {
    this.transfer = transfer;
    this.defaultProjectExists = projectExists;
  }

  /**
   * Parses + validates a backup and returns a preview, or throws a typed
   * `BackupImportError`. Never writes to the database.
   */
  async previewBackupFile(
    input: BackupPreviewInput,
    options: PreviewBackupOptions = {},
  ): Promise<BackupPreview> {
    const text = typeof input === 'string' ? input : input?.text ?? '';
    const fileName =
      options.fileName ??
      (typeof input === 'object' && input && typeof input.name === 'string'
        ? input.name
        : 'backup.n87novel');

    if (text.trim() === '') {
      throw new BackupImportError('empty-input', 'The selected file is empty.');
    }

    const maxBytes = options.maxBytes ?? MAX_BACKUP_FILE_BYTES;
    const fileSizeBytes = utf8ByteLength(text);
    if (fileSizeBytes > maxBytes) {
      throw new BackupImportError(
        'file-too-large',
        `The file is ${formatBytes(fileSizeBytes)}, which exceeds the ${formatBytes(maxBytes)} limit for a project backup.`,
      );
    }

    // Delegate ALL parsing & validation to B1. A successful JSON parse is NOT
    // treated as success: `parse` also runs structural, reference, ownership,
    // version and integrity checks.
    const result = this.transfer.parse(text);

    if (!result.valid || result.package === null) {
      throw this.classifyParseFailure(result);
    }

    const pkg = result.package;

    // Never accept a workspace (or any non-project) package as a backup.
    if (pkg.kind !== 'project') {
      throw new BackupImportError(
        'wrong-package-kind',
        `This file is a "${pkg.kind}" package. Only single-project backups (.n87novel) can be previewed here.`,
      );
    }

    const entry = pkg.projects[0];
    if (!entry) {
      throw new BackupImportError('invalid-package', 'The backup contains no project entry.');
    }

    // READ-ONLY existence probe. It only asks whether the id is present; it never
    // creates, overwrites or otherwise touches the project.
    let sourceProjectExistsLocally: boolean;
    try {
      sourceProjectExistsLocally = await (options.projectExists ?? this.defaultProjectExists)(
        entry.project.id,
      );
    } catch (error) {
      // A probe failure must not be silently reported as "does not exist".
      throw new BackupImportError(
        'invalid-package',
        'The current projects could not be checked to determine whether this backup already exists locally.',
        { cause: error },
      );
    }

    const collections: BackupCollectionCount[] = TRANSFER_COLLECTIONS.map((collection) => {
      const rows = entry.data[collection.key] as unknown as unknown[];
      return {
        key: collection.key,
        table: collection.table,
        count: Array.isArray(rows) ? rows.length : 0,
      };
    });
    const totalRecords = collections.reduce((sum, c) => sum + c.count, 0);

    return {
      fileName,
      fileSizeBytes,
      projectId: entry.project.id,
      projectTitle: entry.project.title,
      kind: 'project',
      formatVersion: pkg.formatVersion,
      schemaVersion: pkg.schemaVersion,
      appVersion: pkg.metadata.appVersion ?? null,
      exportedAt: pkg.metadata.exportedAt,
      integrityDigest: entry.integrity.digest,
      integrityVerified: true,
      collections,
      totalRecords,
      sourceProjectExistsLocally,
      warnings: result.warnings,
    };
  }

  /**
   * Parses + validates a backup and returns the FULL validated project entry,
   * ready to hand to `ProjectRestoreService` (P9 Batch 4-3).
   *
   * Same READ-ONLY parse/validate path as `previewBackupFile` (delegated entirely
   * to B1 `TransferService.parse`); a separate method only because the display
   * preview deliberately does NOT carry the payload. A restore UI re-uses the
   * bytes it already read and calls this at confirm time, so a stale preview can
   * never authorise a write — the restore service re-validates again regardless.
   *
   * Never writes to the database. On any parse/validation/kind failure it throws
   * the same typed `BackupImportError` as `previewBackupFile`.
   */
  async parseBackupEntry(
    input: BackupPreviewInput,
    options: PreviewBackupOptions = {},
  ): Promise<ValidatedBackupEntry> {
    const text = typeof input === 'string' ? input : input?.text ?? '';

    if (text.trim() === '') {
      throw new BackupImportError('empty-input', 'The selected file is empty.');
    }

    const maxBytes = options.maxBytes ?? MAX_BACKUP_FILE_BYTES;
    const fileSizeBytes = utf8ByteLength(text);
    if (fileSizeBytes > maxBytes) {
      throw new BackupImportError(
        'file-too-large',
        `The file is ${formatBytes(fileSizeBytes)}, which exceeds the ${formatBytes(maxBytes)} limit for a project backup.`,
      );
    }

    const result = this.transfer.parse(text);
    if (!result.valid || result.package === null) {
      throw this.classifyParseFailure(result);
    }

    const pkg = result.package;
    if (pkg.kind !== 'project') {
      throw new BackupImportError(
        'wrong-package-kind',
        `This file is a "${pkg.kind}" package. Only single-project backups (.n87novel) can be restored here.`,
      );
    }

    const entry = pkg.projects[0];
    if (!entry) {
      throw new BackupImportError('invalid-package', 'The backup contains no project entry.');
    }

    return { entry, warnings: result.warnings };
  }

  /** Maps a failed B1 validation to the most specific typed import error. */
  private classifyParseFailure(result: TransferValidationResult): BackupImportError {
    const problems = result.problems;
    const codeOf = (c: string) => problems.some((p) => p.code === c);
    const primary = problems.find((p) => p.severity === 'error') ?? problems[0];
    const message = primary?.message ?? 'The file is not a valid project backup.';

    if (codeOf('invalid-json')) {
      return new BackupImportError('invalid-json', message, { problems });
    }
    if (codeOf('unsupported-format-version') || codeOf('unsupported-schema-version')) {
      return new BackupImportError('unsupported-version', message, { problems });
    }
    if (codeOf('integrity-mismatch')) {
      return new BackupImportError('integrity-mismatch', message, { problems });
    }
    // wrong-format / malformed-header / not-an-object / schema-invalid /
    // missing collection / dangling reference / ownership / duplicate / etc.
    return new BackupImportError('invalid-package', message, { problems });
  }
}

/** UTF-8 byte length of a string (its size on disk). */
function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Human-readable byte size for error messages. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Shared singleton for reading / previewing backup files (read-only). */
export const backupPreviewService = new BackupPreviewService();
