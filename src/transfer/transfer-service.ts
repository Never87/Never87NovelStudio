import type { NovelProject } from '@/types';
import {
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_SCHEMA_VERSION,
  TransferPackageSchema,
  type TransferMetadata,
  type TransferPackage,
  type TransferProject,
} from '@/schemas/transfer';
import { EXCLUDED_TABLES } from '@/transfer/collection-registry';
import { canonicalStringify, computeIntegrity } from '@/transfer/canonical-json';
import {
  buildIdMap,
  remapProject,
  AmbiguousIdMapError,
  type IdFactory,
  type RemapResult,
} from '@/transfer/id-mapping';
import {
  describeJsonError,
  validateTransferPackage,
  type TransferProblem,
  type TransferValidationResult,
} from '@/transfer/validation';
import { TransferRepositoryAdapter } from '@/transfer/transfer-repository-adapter';

/**
 * TransferService — the public entry point of the transfer foundation (P9 B1).
 *
 * ## Responsibilities
 *
 *   - SERIALISE one project (or many) into a versioned transfer package.
 *   - DESERIALISE + VALIDATE a package from JSON.
 *   - REMAP a package's ids for a future import-as-new-project.
 *   - Describe the package format (for future UI / documentation).
 *
 * ## Boundaries
 *
 *   - Independent of UI: imports no React, no components, no routes.
 *   - Pure where possible: serialisation, hashing, validation and remapping are
 *     pure functions; only `exportProject`/`exportWorkspace` READ the database,
 *     through `TransferRepositoryAdapter` (read-only).
 *   - NO WRITES: nothing in this class inserts, updates or deletes a row.
 *   - NO secrets: the serializer selects only project-owned collections, and
 *     the AI provider tables (the only credential-bearing tables) are not part
 *     of that set. See `getFormatDescription()` for the explicit exclusion list.
 */

/** Options controlling an export. */
export interface ExportOptions {
  /** Injectable clock (epoch ms) for deterministic tests. */
  readonly now?: number;
  /** Application version string recorded in metadata. */
  readonly appVersion?: string;
  /** Optional human-readable label. */
  readonly label?: string;
}

/** Raised when an export cannot be produced (e.g. the project is missing). */
export class TransferExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferExportError';
  }
}

/** Raised when a serialised package fails validation on the way out. */
export class TransferSerializationError extends Error {
  readonly problems: readonly TransferProblem[];

  constructor(message: string, problems: readonly TransferProblem[]) {
    super(message);
    this.name = 'TransferSerializationError';
    this.problems = problems;
  }
}

/** The result of parsing + validating a JSON file. */
export interface ParseResult extends TransferValidationResult {
  /** The validated package, or `null` when parsing/validation failed. */
  readonly package: TransferPackage | null;
}

/**
 * A static description of the transfer format.
 *
 * Intended for a future "About this export" panel and for tests that assert the
 * documented exclusions match the code. Contains NO project data.
 */
export interface TransferFormatDescription {
  readonly format: typeof TRANSFER_FORMAT;
  readonly formatVersion: number;
  readonly schemaVersion: number;
  readonly includedCollections: string[];
  readonly excludedTables: ReadonlyArray<{ table: string; reason: string }>;
  /** Always `true`: this build never serialises credentials. */
  readonly secretsExcluded: true;
}

export class TransferService {
  private readonly adapter: TransferRepositoryAdapter;

  constructor(adapter: TransferRepositoryAdapter = new TransferRepositoryAdapter()) {
    this.adapter = adapter;
  }

  /* ------------------------------- Export -------------------------------- */

  /**
   * Serialises a single project into a transfer package.
   *
   * @param projectId the project to export
   * @param options clock/version/label metadata
   * @throws TransferExportError when the project does not exist
   * @throws TransferSerializationError when the produced package fails validation
   *   (a programming error rather than bad user data — it means the exporter and
   *   the schemas disagree, and must never be silently written to disk)
   */
  async exportProject(projectId: string, options: ExportOptions = {}): Promise<TransferPackage> {
    const project = await this.loadProject(projectId);
    const data = await this.adapter.readProjectData(projectId);
    const entry: TransferProject = {
      project,
      data,
      integrity: computeIntegrity({ project, data }),
    };

    const pkg = this.buildPackage([entry], 'project', options);

    // Self-check: never hand out a package that its own reader would reject.
    const check = validateTransferPackage(pkg);
    if (!check.valid) {
      throw new TransferSerializationError(
        'The exported package failed its own validation and was not returned',
        check.errors,
      );
    }
    return pkg;
  }

  /**
   * Serialises EVERY project into one workspace package.
   *
   * Shares the exact envelope of a single-project export, so the same reader,
   * validator and remapper handle both.
   */
  async exportWorkspace(options: ExportOptions = {}): Promise<TransferPackage> {
    const projectIds = await this.adapter.listProjectIds();
    const entries: TransferProject[] = [];

    for (const projectId of projectIds) {
      const project = await this.loadProject(projectId);
      const data = await this.adapter.readProjectData(projectId);
      entries.push({ project, data, integrity: computeIntegrity({ project, data }) });
    }

    if (entries.length === 0) {
      throw new TransferExportError('There are no projects to export');
    }

    const pkg = this.buildPackage(entries, 'workspace', options);
    const check = validateTransferPackage(pkg);
    if (!check.valid) {
      throw new TransferSerializationError(
        'The workspace package failed its own validation and was not returned',
        check.errors,
      );
    }
    return pkg;
  }

  /**
   * Serialises a package to a JSON string.
   *
   * Uses the canonical form so two exports of identical data are byte-identical
   * (stable key order), which makes on-disk diffs and integrity checks reliable.
   */
  serialize(pkg: TransferPackage): string {
    return canonicalStringify(pkg);
  }

  /* ------------------------------- Import -------------------------------- */

  /**
   * Parses and fully validates a JSON string.
   *
   * Never throws for bad input: a syntax error becomes an `invalid-json`
   * problem, and every other issue is reported by `validateTransferPackage`.
   */
  parse(json: string): ParseResult {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (error) {
      const problem = describeJsonError(error);
      return {
        valid: false,
        problems: [problem],
        errors: [problem],
        warnings: [],
        package: null,
      };
    }

    const result = validateTransferPackage(raw);
    if (!result.valid) {
      return { ...result, package: null };
    }

    // The validator has already parsed with the strict schema; re-parse here to
    // return the normalised (default-applied) copy with the correct type.
    const parsed = TransferPackageSchema.safeParse(raw);
    return { ...result, package: parsed.success ? parsed.data : null };
  }

  /* ------------------------------ ID mapping ----------------------------- */

  /**
   * Builds an id map for a package's project.
   *
   * Pure; does not touch the database.
   */
  buildIdMap(entry: TransferProject, factory?: IdFactory) {
    return buildIdMap(entry, factory);
  }

  /**
   * Produces a remapped DEEP COPY of a project for a future import.
   *
   * The input entry is never mutated. Throws `AmbiguousIdMapError` when the
   * source contains duplicate ids (ambiguous mapping).
   */
  remapProject(entry: TransferProject, factory?: IdFactory): RemapResult {
    const idMap = buildIdMap(entry, factory);
    return remapProject(entry, idMap);
  }

  /* ----------------------------- Description ----------------------------- */

  /** A static description of the format & its documented exclusions. */
  getFormatDescription(): TransferFormatDescription {
    return {
      format: TRANSFER_FORMAT,
      formatVersion: TRANSFER_FORMAT_VERSION,
      schemaVersion: TRANSFER_SCHEMA_VERSION,
      includedCollections: [
        'worlds',
        'characters',
        'narrativePlans',
        'volumes',
        'chapters',
        'scenes',
        'chapterDrafts',
        'sceneDrafts',
        'draftVersions',
        'promptTemplates',
        'promptTemplateVersions',
        'contextItems',
        'contextConfigs',
        'knowledgeEntries',
        'continuityFacts',
        'analysisFindings',
        'sourceDocuments',
        'documentSections',
        'extractionRecords',
      ],
      excludedTables: EXCLUDED_TABLES,
      secretsExcluded: true,
    };
  }

  /* -------------------------------- Helpers ------------------------------ */

  private async loadProject(projectId: string): Promise<NovelProject> {
    const project = await this.adapter
      .getDatabase()
      .projects.get(projectId)
      .catch((error: unknown) => {
        throw new TransferExportError(
          `Failed to read project "${projectId}": ${error instanceof Error ? error.message : String(error)}`,
        );
      });

    if (project === undefined) {
      throw new TransferExportError(`Project "${projectId}" was not found`);
    }
    return project;
  }

  private buildPackage(
    projects: TransferProject[],
    kind: 'project' | 'workspace',
    options: ExportOptions,
  ): TransferPackage {
    const metadata: TransferMetadata = {
      exportedAt: options.now ?? Date.now(),
      ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
      projectCount: projects.length,
    };

    return {
      format: TRANSFER_FORMAT,
      formatVersion: TRANSFER_FORMAT_VERSION,
      schemaVersion: TRANSFER_SCHEMA_VERSION,
      kind,
      metadata,
      projects,
    };
  }
}

/** Re-exported so callers can narrow remap failures without a second import. */
export { AmbiguousIdMapError };
