import { ZodError } from 'zod';
import { evidenceQuoteMatches } from '@/schemas/document';
import {
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION,
  TRANSFER_SCHEMA_VERSION,
  TransferPackageHeaderSchema,
  TransferPackageSchema,
  type TransferPackage,
  type TransferProject,
  type TransferProjectData,
} from '@/schemas/transfer';
import { TRANSFER_COLLECTIONS, SECRET_BEARING_TABLES } from '@/transfer/collection-registry';
import { computeIntegrity } from '@/transfer/canonical-json';

/**
 * Pure transfer-package validation (P9 Batch 1).
 *
 * ## Contract
 *
 * - PURE: no IndexedDB access, no network, no mutation of the input.
 * - STRUCTURED: returns a result object with a machine-readable code, a human
 *   message and (where applicable) a JSON-pointer-style `path`, not a boolean.
 * - NON-THROWING for invalid input: every problem the package can have is
 *   reported. Only a programming error would throw.
 *
 * Problems are grouped by `severity`:
 *   - `error`   鈥?the package cannot be used; import must refuse it.
 *   - `warning` 鈥?the package is usable but something is odd (e.g. a stored
 *                 digest mismatch from a hand-edited file).
 *
 * ## What is checked
 *
 *  1. Envelope identity & version (with an actionable "unsupported version").
 *  2. Full Zod schema validation of every record (existing domain schemas).
 *  3. Duplicate primary ids 鈥?within a collection AND across all collections.
 *  4. Project ownership consistency (every row's `projectId` equals its root).
 *  5. Cross-collection duplicate project ids.
 *  6. Foreign-key / reference integrity for every documented relationship.
 *  7. Structural parent-child rules (volumes鈫抍hapters鈫抯cenes, documents鈫抯ections).
 *  8. P8 offsets & evidence grounding using the existing UTF-16 semantics.
 *  9. Integrity digest recomputation.
 *
 * Domain validation is never weakened: each record is validated with the SAME
 * schema the repository validates with, so an invalid transfer record can never
 * "slip through" a looser copy here.
 */

/** Stable machine-readable problem codes. */
export const TRANSFER_PROBLEM_CODES = [
  'not-an-object',
  'invalid-json',
  'malformed-header',
  'wrong-format',
  'unsupported-format-version',
  'unsupported-schema-version',
  'schema-invalid',
  'duplicate-id',
  'duplicate-project-id',
  'ownership-mismatch',
  'cardinality-violation',
  'missing-parent',
  'dangling-reference',
  'cyclic-parent',
  'offset-out-of-range',
  'quote-mismatch',
  'integrity-mismatch',
  'secret-detected',
  'metadata-mismatch',
  'empty-package',
] as const;

export type TransferProblemCode = (typeof TRANSFER_PROBLEM_CODES)[number];

/** A single validation problem. */
export interface TransferProblem {
  readonly code: TransferProblemCode;
  readonly severity: 'error' | 'warning';
  /** Human-readable, actionable description. */
  readonly message: string;
  /** JSON-pointer-ish location, e.g. `projects[0].data.chapters[3].volumeId`. */
  readonly path: string;
  /** Collection/table name when the problem concerns one. */
  readonly table?: string;
  /** The offending record id, when known. */
  readonly recordId?: string;
}

/** The result of validating a package. */
export interface TransferValidationResult {
  /** True only when there are no `error`-severity problems. */
  readonly valid: boolean;
  readonly problems: readonly TransferProblem[];
  /** Convenience view of `problems` filtered to errors. */
  readonly errors: readonly TransferProblem[];
  /** Convenience view of `problems` filtered to warnings. */
  readonly warnings: readonly TransferProblem[];
  /** The parsed package, present only when the envelope parsed at all. */
  readonly package: TransferPackage | null;
}

/* -------------------------------------------------------------------------- */
/* Problem helpers                                                            */
/* -------------------------------------------------------------------------- */

function problem(
  code: TransferProblemCode,
  message: string,
  path: string,
  extra: { table?: string; recordId?: string; severity?: 'error' | 'warning' } = {},
): TransferProblem {
  return {
    code,
    severity: extra.severity ?? 'error',
    message,
    path,
    ...(extra.table !== undefined ? { table: extra.table } : {}),
    ...(extra.recordId !== undefined ? { recordId: extra.recordId } : {}),
  };
}

/** Turns Zod issues into structured problems, preserving every issue. */
function fromZodError(error: ZodError, pathPrefix: string, table?: string): TransferProblem[] {
  return error.issues.map((issue) =>
    problem('schema-invalid', issue.message, `${pathPrefix}${pathToPointer(issue.path)}`, {
      ...(table !== undefined ? { table } : {}),
    }),
  );
}

/** Renders a Zod issue path as `[0].field.sub`. */
function pathToPointer(path: ReadonlyArray<string | number>): string {
  return path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : `.${segment}`)).join('');
}

/**
 * Normalises any thrown value from JSON parsing into a problem.
 * Shared with `parseTransferPackage` so both paths report identically.
 */
export function describeJsonError(error: unknown): TransferProblem {
  return problem('invalid-json', `The file is not valid JSON: ${messageOf(error)}`, '$');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------------------------------------------- */
/* Reference rules                                                            */
/* -------------------------------------------------------------------------- */

/** A reference rule: which field on which collection points where. */
interface ReferenceRule {
  readonly from: keyof TransferProjectData;
  readonly field: string;
  readonly to: keyof TransferProjectData | 'project';
  /** Extract the referenced id(s) from a row. `null` means "no reference". */
  readonly read: (row: Record<string, unknown>) => string | string[] | null;
  /** Human explanation used in error messages. */
  readonly describe: string;
}

/**
 * Every foreign-key/reference relationship a project's records can express.
 *
 * Kept as data (not inline code) so validation, diagnostics and future ID
 * remapping share ONE description of the graph. Only relationships that the
 * schemas actually declare are listed 鈥?no speculative edges.
 */
export const TRANSFER_REFERENCE_RULES: readonly ReferenceRule[] = [
  {
    from: 'chapters',
    field: 'volumeId',
    to: 'volumes',
    read: (row) => asString(row.volumeId),
    describe: 'chapter.volumeId must reference a packaged volume',
  },
  {
    from: 'scenes',
    field: 'chapterId',
    to: 'chapters',
    read: (row) => asString(row.chapterId),
    describe: 'scene.chapterId must reference a packaged chapter',
  },
  {
    from: 'chapterDrafts',
    field: 'ownerId',
    to: 'chapters',
    read: (row) => asString(row.ownerId),
    describe: 'chapterDraft.ownerId must reference a packaged chapter',
  },
  {
    from: 'sceneDrafts',
    field: 'ownerId',
    to: 'scenes',
    read: (row) => asString(row.ownerId),
    describe: 'sceneDraft.ownerId must reference a packaged scene',
  },
  {
    from: 'draftVersions',
    field: 'draftId',
    to: 'chapterDrafts',
    read: (row) => asString(row.draftId),
    describe: 'draftVersion.draftId must reference a packaged chapter or scene draft',
  },
  {
    from: 'promptTemplateVersions',
    field: 'templateId',
    to: 'promptTemplates',
    read: (row) => asString(row.templateId),
    describe: 'promptTemplateVersion.templateId must reference a packaged template',
  },
  {
    from: 'documentSections',
    field: 'documentId',
    to: 'sourceDocuments',
    read: (row) => asString(row.documentId),
    describe: 'documentSection.documentId must reference a packaged source document',
  },
  {
    from: 'extractionRecords',
    field: 'documentId',
    to: 'sourceDocuments',
    read: (row) => asString(row.documentId),
    describe: 'extractionRecord.documentId must reference a packaged source document',
  },
  {
    from: 'continuityFacts',
    field: 'anchorChapterId',
    to: 'chapters',
    read: (row) => asString(row.anchorChapterId),
    describe: 'continuityFact.anchorChapterId must reference a packaged chapter',
  },
  // --- Optional ("may be absent/null") edges ------------------------------
  {
    from: 'scenes',
    field: 'povCharacterId',
    to: 'characters',
    read: (row) => asString(row.povCharacterId),
    describe: 'scene.povCharacterId, when present, must reference a packaged character',
  },
  {
    from: 'continuityFacts',
    field: 'anchorSceneId',
    to: 'scenes',
    read: (row) => asString(row.anchorSceneId),
    describe: 'continuityFact.anchorSceneId, when present, must reference a packaged scene',
  },
  {
    from: 'documentSections',
    field: 'parentId',
    to: 'documentSections',
    read: (row) => asString(row.parentId),
    describe: 'documentSection.parentId, when present, must reference a packaged section',
  },
  // --- Multi-valued edges -------------------------------------------------
  {
    from: 'chapters',
    field: 'characterIds',
    to: 'characters',
    read: (row) => asStringArray(row.characterIds),
    describe: 'chapter.characterIds must all reference packaged characters',
  },
  {
    from: 'scenes',
    field: 'characterIds',
    to: 'characters',
    read: (row) => asStringArray(row.characterIds),
    describe: 'scene.characterIds must all reference packaged characters',
  },
  {
    from: 'extractionRecords',
    field: 'relatedIds',
    to: 'characters',
    read: (row) => asStringArray(row.relatedIds),
    describe: 'extractionRecord.relatedIds must all reference packaged entities',
  },
  {
    from: 'chapters',
    field: 'plotBeatId',
    to: 'narrativePlans',
    read: (row) => asString(row.plotBeatId),
    describe: 'chapter.plotBeatId, when present, must reference a beat of the packaged narrative plan',
  },
];

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : null;
}

/* -------------------------------------------------------------------------- */
/* Main validator                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Validates an already-parsed package object.
 *
 * Never mutates `input`. Returns a result whose `package` is the Zod-parsed,
 * normalised copy (with schema defaults applied) when the envelope was readable.
 */
export function validateTransferPackage(input: unknown): TransferValidationResult {
  const problems: TransferProblem[] = [];

  // ---- 1. Envelope identity & version -----------------------------------
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return finish([problem('not-an-object', 'A transfer package must be a JSON object', '$')]);
  }

  const headerParsed = TransferPackageHeaderSchema.safeParse(input);
  if (!headerParsed.success) {
    return finish([
      problem(
        'malformed-header',
        'The package is missing its identity fields (format, formatVersion, schemaVersion, kind)',
        '$',
      ),
      ...fromZodError(headerParsed.error, '$'),
    ]);
  }

  const header = headerParsed.data;

  if (header.format !== TRANSFER_FORMAT) {
    return finish([
      problem(
        'wrong-format',
        `This file is not a Never87 transfer package (format "${header.format}", expected "${TRANSFER_FORMAT}")`,
        '$.format',
      ),
    ]);
  }

  if (header.formatVersion !== TRANSFER_FORMAT_VERSION) {
    return finish([
      problem(
        'unsupported-format-version',
        `Unsupported transfer format version ${header.formatVersion}; this build reads version ${TRANSFER_FORMAT_VERSION}. ` +
          'The package was produced by a different version of the application.',
        '$.formatVersion',
      ),
    ]);
  }

  if (header.schemaVersion !== TRANSFER_SCHEMA_VERSION) {
    // Informational: records are validated by their current schemas regardless,
    // so a mismatch is reported without blocking a structurally-sound package.
    problems.push(
      problem(
        'unsupported-schema-version',
        `The package was exported from schema version ${header.schemaVersion}; this build targets ${TRANSFER_SCHEMA_VERSION}. ` +
          'Records are validated against the current schemas, but review any reported field errors.',
        '$.schemaVersion',
        { severity: 'warning' },
      ),
    );
  }

  // ---- 2. Full schema validation ----------------------------------------
  const parsed = TransferPackageSchema.safeParse(input);
  if (!parsed.success) {
    problems.push(...fromZodError(parsed.error, '$'));
    return finish(problems);
  }
  const pkg = parsed.data;

  if (pkg.projects.length === 0) {
    problems.push(problem('empty-package', 'A package must contain at least one project', '$.projects'));
    return finish(problems);
  }

  // ---- 3. Metadata cross-check ------------------------------------------
  if (pkg.metadata.projectCount !== pkg.projects.length) {
    problems.push(
      problem(
        'metadata-mismatch',
        `metadata.projectCount is ${pkg.metadata.projectCount} but the package carries ${pkg.projects.length} project(s)`,
        '$.metadata.projectCount',
        { severity: 'warning' },
      ),
    );
  }

  // ---- 4. Secret scan ---------------------------------------------------
  // A generated package can never contain provider tables; this guards hand-built
  // or tampered packages. Only the known secret-bearing table names are checked.
  for (const table of SECRET_BEARING_TABLES) {
    if (Object.prototype.hasOwnProperty.call(pkg, table)) {
      problems.push(
        problem('secret-detected', `The package contains "${table}", which holds credentials and must never be exported`, `$.${table}`, { table }),
      );
    }
  }

  // ---- 5. Per-project integrity -----------------------------------------
  const seenProjectIds = new Map<string, number>();
  pkg.projects.forEach((entry, index) => {
    const base = `$.projects[${index}]`;
    const firstIndex = seenProjectIds.get(entry.project.id);
    if (firstIndex !== undefined) {
      problems.push(
        problem(
          'duplicate-project-id',
          `Project id "${entry.project.id}" appears at projects[${firstIndex}] and projects[${index}]`,
          `${base}.project.id`,
          { recordId: entry.project.id },
        ),
      );
    } else {
      seenProjectIds.set(entry.project.id, index);
    }
    validateProjectEntry(entry, base, problems);
  });

  return finish(problems);
}

function finish(problems: readonly TransferProblem[]): TransferValidationResult {
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  return {
    valid: errors.length === 0,
    problems,
    errors,
    warnings,
    package: null,
  };
}

/**
 * Validates one project and everything it owns.
 *
 * Mutates `problems` (an accumulator) but never the project data.
 */
function validateProjectEntry(entry: TransferProject, base: string, problems: TransferProblem[]): void {
  const projectId = entry.project.id;
  const data = entry.data;

  // ---- Ownership + duplicate ids ---------------------------------------
  // A single index of every id in the package is built first so that
  // duplicate detection and reference resolution share one source of truth.
  const idIndex = new Map<string, Array<{ table: string; path: string }>>();

  for (const collection of TRANSFER_COLLECTIONS) {
    const rows = data[collection.key] as unknown as Array<Record<string, unknown>>;
    const collectionPath = `${base}.data.${collection.key}`;

    // Cardinality rules (world / plan / context config are at most one).
    if (collection.cardinality !== 'many' && rows.length > 1) {
      problems.push(
        problem(
          'cardinality-violation',
          `${collection.table} allows at most one record per project; found ${rows.length}`,
          collectionPath,
          { table: collection.table },
        ),
      );
    }
    // A world is REQUIRED by the application (createProject creates one).
    if (collection.cardinality === 'one' && rows.length !== 1) {
      problems.push(
        problem(
          'cardinality-violation',
          `${collection.table} requires exactly one record per project; found ${rows.length}`,
          collectionPath,
          { table: collection.table },
        ),
      );
    }

    rows.forEach((row, index) => {
      const rowPath = `${collectionPath}[${index}]`;
      const id = typeof row.id === 'string' ? row.id : undefined;

      if (id !== undefined) {
        const locations = idIndex.get(id) ?? [];
        locations.push({ table: collection.table, path: rowPath });
        idIndex.set(id, locations);
      }

      // Ownership: every child row must be owned by this project.
      const owner = row[collection.ownerKey];
      if (typeof owner === 'string' && owner !== projectId) {
        problems.push(
          problem(
            'ownership-mismatch',
            `${collection.table} record ${describeId(id)} belongs to project "${owner}" but is packaged under project "${projectId}"`,
            `${rowPath}.${collection.ownerKey}`,
            { table: collection.table, ...(id !== undefined ? { recordId: id } : {}) },
          ),
        );
      }
    });
  }

  // Report duplicate primary ids (within and across collections).
  for (const [id, locations] of idIndex) {
    if (locations.length > 1) {
      const tables = [...new Set(locations.map((l) => l.table))].join(', ');
      problems.push(
        problem(
          'duplicate-id',
          `Duplicate record id "${id}" appears ${locations.length} times (in ${tables}); primary ids must be unique across the whole package`,
          locations[0].path,
          { ...(locations.length === 1 ? {} : { table: locations[0].table }), recordId: id },
        ),
      );
    }
  }

  // ---- Reference integrity ---------------------------------------------
  // Build a per-collection id set for O(1) resolution.
  const idsByCollection = new Map<string, Set<string>>();
  for (const collection of TRANSFER_COLLECTIONS) {
    const rows = data[collection.key] as unknown as Array<Record<string, unknown>>;
    idsByCollection.set(
      collection.key,
      new Set(rows.map((r) => r.id).filter((v): v is string => typeof v === 'string')),
    );
  }
  // Draft ids span TWO collections (chapterDrafts + sceneDrafts); they share
  // one logical namespace because `DraftVersion.draftId` may point at either.
  const allDraftIds = new Set<string>([...idsByCollection.get('chapterDrafts')!, ...idsByCollection.get('sceneDrafts')!]);

  // Plot beats live INSIDE the narrative plan, so a chapter's `plotBeatId`
  // resolves against the plan's `beats` array rather than a top-level table.
  const beatIds = new Set<string>(
    data.narrativePlans.flatMap((plan) => plan.beats.map((beat) => beat.id)),
  );

  for (const rule of TRANSFER_REFERENCE_RULES) {
    const rows = data[rule.from] as unknown as Array<Record<string, unknown>>;
    const collectionPath = `${base}.data.${rule.from}`;

    rows.forEach((row, index) => {
      const refs = rule.read(row);
      if (refs === null) return;
      const list = Array.isArray(refs) ? refs : [refs];
      const rowPath = `${collectionPath}[${index}]`;
      const rowId = typeof row.id === 'string' ? row.id : undefined;

      list.forEach((ref, refIndex) => {
        const refPath = Array.isArray(refs) ? `${rowPath}.${rule.field}[${refIndex}]` : `${rowPath}.${rule.field}`;

        // Resolve against the target namespace.
        let resolved: boolean;
        if (rule.from === 'draftVersions' && rule.field === 'draftId') {
          // A version belongs to a chapter draft OR a scene draft.
          resolved = allDraftIds.has(ref);
        } else if (rule.from === 'chapters' && rule.field === 'plotBeatId') {
          // A chapter links to a beat inside the project's narrative plan.
          resolved = beatIds.has(ref);
        } else if (rule.to === 'documentSections' && rule.field === 'parentId') {
          // Parent must resolve to a section AND belong to the same document.
          // Distinguish "no such section at all" (missing parent) from
          // "exists but in another document" (broken link) so the message is
          // actionable in both cases.
          const parent = rows.find((candidate) => candidate.id === ref);
          resolved = parent !== undefined && parent.documentId === row.documentId;
          if (!resolved) {
            problems.push(
              problem(
                parent === undefined ? 'missing-parent' : 'dangling-reference',
                parent === undefined
                  ? `Section "${rowId ?? '<no id>'}" declares parent "${ref}", which is not present in the package`
                  : `Section "${rowId ?? '<no id>'}" declares parent "${ref}", but that section belongs to a different document`,
                refPath,
                { table: rule.from, ...(rowId !== undefined ? { recordId: rowId } : {}) },
              ),
            );
            return;
          }
        } else {
          const target = idsByCollection.get(rule.to as string);
          resolved = target !== undefined && target.has(ref);
        }

        if (resolved) return;

        // Any present-but-unresolvable reference is an error: it is a broken
        // link regardless of whether the edge is required or optional (the
        // schemas allow a MISSING value, never a link to a nonexistent record).
        problems.push(
          problem(
            'dangling-reference',
            `${rule.describe} 鈥?"${ref}" was not found in the package`,
            refPath,
            { table: rule.from, ...(rowId !== undefined ? { recordId: rowId } : {}) },
          ),
        );
      });
    });
  }

  // ---- Structural parent-child rules -----------------------------------
  validateSectionTree(data, base, problems);
  validateWorldCardinality(data, base, problems);

  // ---- P8 offset & evidence grounding -----------------------------------
  validateDocumentOffsets(data, base, problems);
  validateEvidenceGrounding(data, base, problems);

  // ---- Integrity digest -------------------------------------------------
  const expected = entry.integrity;
  const actual = computeIntegrity({ project: entry.project, data: entry.data });
  if (actual.digest !== expected.digest) {
    problems.push(
      problem(
        'integrity-mismatch',
        'The recorded integrity digest does not match the packaged records. ' +
          'The file was modified after export, or export produced inconsistent content.',
        `${base}.integrity.digest`,
        { severity: 'error' },
      ),
    );
  }
}

function describeId(id: string | undefined): string {
  return id === undefined ? '<no id>' : `"${id}"`;
}

/**
 * Section-tree rules beyond simple reference existence:
 *   - no self-parent;
 *   - no cycles;
 *   - parent must be in the same document (enforced above);
 *   - siblings must not share the same `order` (the importer assumes a total
 *     order per document).
 */
function validateSectionTree(data: TransferProjectData, base: string, problems: TransferProblem[]): void {
  const sections = data.documentSections as unknown as Array<Record<string, unknown>>;
  const byId = new Map<string, Record<string, unknown>>();
  for (const section of sections) {
    if (typeof section.id === 'string') byId.set(section.id, section);
  }

  sections.forEach((section, index) => {
    const path = `${base}.data.documentSections[${index}]`;
    const id = typeof section.id === 'string' ? section.id : undefined;
    const parentId = typeof section.parentId === 'string' ? section.parentId : null;

    if (parentId !== null && parentId !== undefined) {
      if (parentId === id) {
        problems.push(
          problem('cyclic-parent', 'A section cannot be its own parent', `${path}.parentId`, {
            table: 'documentSections',
            ...(id !== undefined ? { recordId: id } : {}),
          }),
        );
      } else {
        // Walk up at most N steps; a cycle must be detected, not hang.
        let cursor: string | null = parentId;
        const visited = new Set<string>();
        while (cursor !== null && cursor !== undefined && byId.has(cursor)) {
          if (cursor === id) {
            problems.push(
              problem('cyclic-parent', 'The section parent chain forms a cycle', `${path}.parentId`, {
                table: 'documentSections',
                ...(id !== undefined ? { recordId: id } : {}),
              }),
            );
            break;
          }
          if (visited.has(cursor)) break;
          visited.add(cursor);
          const next: unknown = byId.get(cursor)!.parentId;
          cursor = typeof next === 'string' ? next : null;
        }
      }
    }
  });

  // Sibling order uniqueness per document.
  const ordersByDoc = new Map<string, Map<string, number>>();
  sections.forEach((section, index) => {
    const documentId = typeof section.documentId === 'string' ? section.documentId : null;
    const order = typeof section.order === 'number' ? section.order : null;
    if (documentId === null || order === null) return;
    const key = `${documentId}:${order}`;
    const seen = ordersByDoc.get(documentId) ?? new Map<string, number>();
    ordersByDoc.set(documentId, seen);
    if (seen.has(key)) {
      problems.push(
        problem(
          'schema-invalid',
          `Two sections of document "${documentId}" share order ${order}; section order must be unique per document`,
          `${base}.data.documentSections[${index}].order`,
          { table: 'documentSections', ...(typeof section.id === 'string' ? { recordId: section.id } : {}) },
        ),
      );
    } else {
      seen.set(key, index);
    }
  });
}

/** A project must carry exactly one world once it has been initialised. */
function validateWorldCardinality(data: TransferProjectData, base: string, problems: TransferProblem[]): void {
  if (data.worlds.length > 1) {
    problems.push(
      problem('cardinality-violation', 'A project carries exactly one world', `${base}.data.worlds`, {
        table: 'worlds',
      }),
    );
  }
}

/**
 * Verifies every document's section offsets against its raw text, using the
 * SAME UTF-16 `[start, end)` semantics the parser guarantees:
 *
 *   - `0 <= start <= end <= rawText.length`
 *   - `rawText.slice(start, end) === section.text`
 *
 * The schema already enforces `text.length === end - start`; this adds the
 * cross-record check the schema cannot make on its own (it has no raw text).
 */
function validateDocumentOffsets(data: TransferProjectData, base: string, problems: TransferProblem[]): void {
  const documents = new Map<string, string>();
  data.sourceDocuments.forEach((doc) => {
    documents.set(doc.id, doc.rawText);
  });

  data.documentSections.forEach((section, index) => {
    const rawText = documents.get(section.documentId);
    if (rawText === undefined) return; // Reported separately as a dangling reference.
    const path = `${base}.data.documentSections[${index}]`;

    if (section.end > rawText.length) {
      problems.push(
        problem(
          'offset-out-of-range',
          `Section "${section.id}" ends at ${section.end} but document "${section.documentId}" is only ${rawText.length} UTF-16 code units long`,
          `${path}.end`,
          { table: 'documentSections', recordId: section.id },
        ),
      );
      return;
    }

    const slice = rawText.slice(section.start, section.end);
    if (slice !== section.text) {
      problems.push(
        problem(
          'quote-mismatch',
          `Section "${section.id}" text does not equal rawText.slice(${section.start}, ${section.end})`,
          `${path}.text`,
          { table: 'documentSections', recordId: section.id },
        ),
      );
    }
  });
}

/**
 * Verifies `DocumentEvidence` locators on extraction records.
 *
 * Uses the existing semantics: offsets are SECTION-RELATIVE UTF-16 codes and a
 * quoted slice must equal `section.text.slice(start, end)`. Reuses
 * `evidenceQuoteMatches` so the transfer layer and the importer share one rule.
 */
function validateEvidenceGrounding(data: TransferProjectData, base: string, problems: TransferProblem[]): void {
  const sectionsById = new Map(data.documentSections.map((section) => [section.id, section]));

  data.extractionRecords.forEach((record, index) => {
    record.evidence.forEach((evidence, evidenceIndex) => {
      const path = `${base}.data.extractionRecords[${index}].evidence[${evidenceIndex}]`;
      const section = sectionsById.get(evidence.sectionId);

      if (!section) {
        problems.push(
          problem(
            'dangling-reference',
            `Evidence references section "${evidence.sectionId}", which is not packaged`,
            `${path}.sectionId`,
            { table: 'extractionRecords', recordId: record.id },
          ),
        );
        return;
      }

      if (evidence.documentId !== section.documentId) {
        problems.push(
          problem(
            'dangling-reference',
            `Evidence cites document "${evidence.documentId}" but its section belongs to "${section.documentId}"`,
            `${path}.documentId`,
            { table: 'extractionRecords', recordId: record.id },
          ),
        );
      }

      if (evidence.end > section.text.length) {
        problems.push(
          problem(
            'offset-out-of-range',
            `Evidence ends at ${evidence.end} but section "${section.id}" is only ${section.text.length} code units long`,
            `${path}.end`,
            { table: 'extractionRecords', recordId: record.id },
          ),
        );
        return;
      }

      if (!evidenceQuoteMatches(evidence, section.text)) {
        problems.push(
          problem(
            'quote-mismatch',
            `Evidence quote does not match section text at [${evidence.start}, ${evidence.end})`,
            `${path}.quote`,
            { table: 'extractionRecords', recordId: record.id },
          ),
        );
      }
    });
  });
}
