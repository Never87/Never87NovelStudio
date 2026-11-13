import { ZodError } from 'zod';
import { now } from '@/utils/date';
import type { DocumentFormat, DocumentSection, DocumentSectionLevel, SourceDocument } from '@/types';
import { parseDocument as parseRawDocument, DocumentParseError } from '@/utils/document-parser';
import { hashRawText, isCurrentHashFormat } from '@/utils/text-hash';
import { createSourceDocumentId, createDocumentSectionId } from '@/utils/id';
import { ImportRepository } from '@/repositories/import-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';



import { ProjectServiceError, ProjectService } from './project-service';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Base class for import-pipeline business errors. */
export class ImportServiceError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ImportServiceError';
  }
}

/** A document or section was not found within the requested project. */
export class ImportNotFoundError extends ImportServiceError {
  constructor(what: string) {
    super(`${what} was not found`);
    this.name = 'ImportNotFoundError';
  }
}

/**
 * A lifecycle/consistency rule blocked an operation — e.g. trying to reparse a
 * document whose structure is confirmed, or whose sections are referenced by an
 * extraction record. Carries a machine-readable `reason` for callers/tests.
 */
export class ImportConflictError extends ImportServiceError {
  readonly reason:
    | 'structure-confirmed'
    | 'has-extraction-references'
    | 'content-unchanged'
    | 'not-parsed'
    | 'already-parsed'
    | 'invalid-structure'
    | 'raw-text-immutable';

  constructor(reason: ImportConflictError['reason'], message: string) {
    super(message);
    this.name = 'ImportConflictError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Public input/output shapes                                                 */
/* -------------------------------------------------------------------------- */

/** Fields a caller may set when registering a new document. */
export interface CreateDocumentInput {
  /** Original file name, or omit/null for pasted text. */
  fileName?: string | null;
  /** `txt` (default) or `markdown`. */
  format?: DocumentFormat;
  /** The raw manuscript text (immutable afterwards). */
  rawText: string;
}

/** Fields a caller may change when adjusting one section's STRUCTURE. */
export interface UpdateSectionInput {
  /** New heading text (structure metadata only — never the raw text). */
  title?: string;
  /** New structural level. */
  level?: DocumentSectionLevel;
  /** New parent id (`null` for root). Reparenting validates no cycles/level drift. */
  parentId?: string | null;
}

/** Outcome of a parse / reparse run. */
export interface ParseDocumentResult {
  document: SourceDocument;
  sections: DocumentSection[];
  /** True when sections were (re)generated; false for an idempotent no-op. */
  parsed: boolean;
  /** Number of sections created. */
  sectionCount: number;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Structural rank — a child must have a STRICTLY greater rank than its parent. */
const LEVEL_RANK: Record<DocumentSectionLevel, number> = {
  volume: 0,
  chapter: 1,
  scene: 2,
  paragraph: 3,
};

/**
 * Fingerprint of a document's raw text (`sha256:<64 hex>`).
 *
 * Delegates to the pure, synchronous SHA-256 utility so the result is identical
 * across every environment and can be computed OUTSIDE any Dexie transaction
 * (no async await inside a transaction scope). It hashes the raw string bytes
 * only — never normalised, trimmed, or line-ending-adjusted (see
 * `@/utils/text-hash`).
 *
 * Retained under this name for existing callers; new code should use
 * `hashRawText` directly.
 */
export function hashText(text: string): string {
  return hashRawText(text);
}

/** CJK-aware word count (duplicated minimal version to avoid a cross-import). */
function countWordsForImport(text: string): number {
  const cjkRe = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
  if (!text) return 0;
  const cjk = text.match(cjkRe);
  const cjkCount = cjk ? cjk.length : 0;
  const nonCjk = text.replace(cjkRe, ' ');
  const runs = nonCjk.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return cjkCount + (runs ? runs.length : 0);
}

/**
 * Whether a document's stored hash proves the raw text is UNCHANGED.
 *
 * Strict equality against the freshly computed tagged SHA-256 — with one hard
 * rule: a stored value that is NOT in the current (`sha256:`) format is treated
 * as a mismatch. This makes legacy 8-hex FNV digests (and any unknown future
 * format) FAIL this check, so the document flows through the normal guarded
 * re-parse path instead of being silently assumed equal. Legacy data therefore
 * never masquerades as a current hash.
 */
function rawTextMatchesHash(stored: string | null | undefined, rawText: string): boolean {
  if (!isCurrentHashFormat(stored)) return false;
  return stored === hashRawText(rawText);
}

/* -------------------------------------------------------------------------- */
/* ImportService                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Business layer for the Import pipeline (P8 Batch 2).
 *
 * Owns the document LIFECYCLE (register → parse → confirm), STRUCTURE editing
 * (title/level/parent/order) and STRUCTURE confirmation. It never touches
 * Dexie tables directly — all persistence goes through `ImportRepository`
 * (validated against the Zod schemas), and multi-row writes run inside a single
 * Dexie transaction so a partial failure can never leave a half-parsed document.
 *
 * ## Lifecycle (DocumentStatus)
 *
 *   imported ──parse()──▶ parsed ──(user confirms)──▶ parsed (confirmed)
 *      ▲                     │                              │
 *      │                     └──(structure edit)──▶ confirmation cleared
 *      │                                     │
 *      └── reparse (only when safe) ◀────────┘
 *
 * `extracted` is set later by the (future) extraction batch; it is accepted as a
 * terminal-ish state here (reparse rules treat it like `parsed` but protected).
 *
 * ## Invariants enforced
 *   - Every read/write is scoped by `projectId`; cross-project ids are rejected.
 *   - `rawText` is IMMUTABLE: no method here ever rewrites it.
 *   - Every section satisfies `rawText.slice(start,end) === text` (the parser
 *     guarantees it; parse re-verifies before writing).
 *   - `parentId` never points to another document, and the section tree is
 *     acyclic with strictly increasing level rank down the tree.
 *   - Any structural edit clears `structureConfirmedAt`.
 */
export class ImportService {
  private readonly repository: ImportRepository;
  private readonly projectService: Pick<ProjectService, 'projectExists'>;
  private readonly db: NovelStudioDb;

  /**
   * Per-document parse locks. Re-parsing the same document concurrently (e.g.
   * two rapid clicks, or React StrictMode double-invocation) is serialised here
   * so the second call observes the first call's committed result and becomes an
   * idempotent no-op instead of writing a duplicate section set. Keyed by
   * document id; entries are removed once the chained operation settles.
   */
  private readonly parseLocks = new Map<string, Promise<unknown>>();

  constructor(deps: {
    repository?: ImportRepository;
    projectService?: Pick<ProjectService, 'projectExists'>;
    db?: NovelStudioDb;
  } = {}) {
    this.db = deps.db ?? getDb();
    this.repository = deps.repository ?? new ImportRepository(this.db);
    this.projectService = deps.projectService ?? new ProjectService();
  }

  /* ------------------------------ Documents ----------------------------- */

  /**
   * Registers a new document (status `imported`) for a project.
   *
   * - Verifies the project exists (never creates an orphan document).
   * - Computes/validates `characterCount`/`wordCount`; the raw text is stored
   *   verbatim and can never be changed afterwards.
   * - The document is NOT parsed here — parsing is a distinct, explicit step.
   */
  async createDocument(projectId: string, input: CreateDocumentInput): Promise<SourceDocument> {
    await this.requireProject(projectId, 'create a document');
    if (typeof input.rawText !== 'string' || input.rawText.length === 0) {
      throw new ImportServiceError('Cannot register an empty document.');
    }
    const timestamp = now();
    const document: SourceDocument = {
      id: createSourceDocumentId(),
      projectId,
      fileName: input.fileName ?? null,
      format: input.format ?? 'txt',
      rawText: input.rawText,
      characterCount: input.rawText.length,
      wordCount: countWordsForImport(input.rawText),
      status: 'imported',
      parsedAt: null,
      structureConfirmedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      return await this.repository.createDocument(document);
    } catch (error) {
      throw this.wrap(error, `Failed to register document`);
    }
  }

  /** Returns the document when it exists AND belongs to `projectId`, else null. */
  async getDocument(projectId: string, documentId: string): Promise<SourceDocument | null> {
    try {
      const document = await this.repository.getDocumentById(documentId);
      if (!document || document.projectId !== projectId) return null;
      return document;
    } catch (error) {
      throw this.wrap(error, `Failed to load document "${documentId}"`);
    }
  }

  /** All documents of `projectId`, most recently updated first. */
  async listDocuments(projectId: string): Promise<SourceDocument[]> {
    try {
      return await this.repository.listDocumentsByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list documents of project "${projectId}"`);
    }
  }

  /**
   * Deletes a document AND its sections AND their extraction records.
   *
   * Child-first, inside one transaction, scoped to `projectId` (a document id
   * from another project is treated as not-found and never removed). Idempotent
   * with respect to missing children.
   */
  async deleteDocument(projectId: string, documentId: string): Promise<void> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    try {
      await this.db.transaction(
        'rw',
        this.db.sourceDocuments,
        this.db.documentSections,
        this.db.extractionRecords,
        async () => {
          // Extractions cited this document — remove them first (leaf).
          const extractions = await this.repository.listExtractionsByDocument(documentId);
          for (const record of extractions) {
            if (record.projectId === projectId) await this.repository.deleteExtraction(record.id);
          }
          const sections = await this.repository.listSectionsByDocument(documentId);
          for (const section of sections) {
            if (section.projectId === projectId) await this.repository.deleteSection(section.id);
          }
          await this.repository.deleteDocument(documentId);
        },
      );
    } catch (error) {
      throw this.wrap(error, `Failed to delete document "${documentId}"`);
    }
  }

  /* ------------------------------- Parsing ------------------------------ */

  /**
   * Parses the document's `rawText` into `DocumentSection`s and persists them.
   *
   * Idempotent and safe:
   *   - If the document is already parsed AND the raw text is unchanged (hash
   *     matches), this is a NO-OP returning the existing sections — repeated or
   *     concurrent calls never create duplicate sections.
   *   - A first parse (status `imported`) generates sections and moves the
   *     document to `parsed`.
   *   - Parsing runs inside a single transaction that also deletes any pre-
   *     existing (stale) sections, so a mid-way failure leaves the document in
   *     its previous state (never a half-written set).
   *   - The parser's offset invariant is re-verified before writing; a violation
   *     aborts the whole transaction.
   */
  async parseDocument(projectId: string, documentId: string): Promise<ParseDocumentResult> {
    return this.withParseLock(documentId, () => this.parseDocumentUnlocked(projectId, documentId));
  }

  /** Lock-free body of `parseDocument` (see the public wrapper for locking). */
  private async parseDocumentUnlocked(projectId: string, documentId: string): Promise<ParseDocumentResult> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);

    const incomingHash = hashText(document.rawText);

    // Idempotent short-circuit: already parsed and text unchanged → no-op.
    // (A legacy/unknown stored hash never matches → falls through to re-parse.)
    if (document.status !== 'imported' && rawTextMatchesHash(document.parsedTextHash, document.rawText)) {
      const existing = await this.repository.listSectionsByDocument(documentId);
      return { document, sections: existing, parsed: false, sectionCount: existing.length };
    }

    // If sections already exist (status parsed) but the hash differs — the text
    // changed. Go through the guarded reparse path instead of silently wiping.
    if (document.status !== 'imported') {

      // Call the UNLOCKED reparse: we already hold this document's lock.
      return this.reparseDocumentUnlocked(projectId, documentId, { force: false });
    }

    return this.generateAndPersist(projectId, document, incomingHash);
  }

  /**
   * Re-parses a document whose raw text changed AFTER it was first parsed.
   *
   * Protection rules (per the batch brief):
   *   - If the text is unchanged (hash matches) → idempotent no-op.
   *   - If the structure has been CONFIRMED by the user → refuse unless `force`.
   *   - If ANY current section is referenced by an ExtractionRecord → refuse
   *     ALWAYS (even with `force`); provenance must never be silently destroyed.
   *   - Otherwise (unconfirmed, unreferenced) → regenerate sections.
   *
   * Regenerating clears the structure confirmation (the structure is new).
   */
  async reparseDocument(
    projectId: string,
    documentId: string,
    options: { force?: boolean } = {},
  ): Promise<ParseDocumentResult> {
    return this.withParseLock(documentId, () => this.reparseDocumentUnlocked(projectId, documentId, options));
  }

  /** Lock-free body of `reparseDocument` (see the public wrapper for locking). */
  private async reparseDocumentUnlocked(
    projectId: string,
    documentId: string,
    options: { force?: boolean } = {},
  ): Promise<ParseDocumentResult> {
    const force = options.force === true;
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);

    const incomingHash = hashText(document.rawText);
    const existingSections = await this.repository.listSectionsByDocument(documentId);

    // Content unchanged → nothing to do. (A legacy/unknown stored hash does NOT
    // count as unchanged, so such documents are safely regenerated below rather
    // than silently skipped.)
    if (rawTextMatchesHash(document.parsedTextHash, document.rawText)) {
      return { document, sections: existingSections, parsed: false, sectionCount: existingSections.length };
    }

    // Referenced sections are inviolable: never silently delete provenance.
    const referenced = await this.findReferencedSectionIds(projectId, documentId);
    if (existingSections.some((s) => referenced.has(s.id))) {
      throw new ImportConflictError(
        'has-extraction-references',
        `Document "${documentId}" has sections referenced by extraction records; ` +
          'resolve or remove those records before re-parsing.',
      );
    }

    // Confirmed (user-checked) structure requires an explicit force.
    if (document.structureConfirmedAt != null && !force) {
      throw new ImportConflictError(
        'structure-confirmed',
        `Document "${documentId}" has a confirmed structure; pass { force: true } to re-parse and discard it.`,
      );
    }

    return this.generateAndPersist(projectId, document, incomingHash);
  }

  /**
   * Runs the pure parser, builds validated `DocumentSection` rows (mapping the
   * parser's `parentIndex` to stable ids), and writes them transactionally —
   * deleting any pre-existing sections first so the document always ends with
   * exactly one coherent set.
   */
  private async generateAndPersist(
    projectId: string,
    document: SourceDocument,
    rawTextHash: string,
  ): Promise<ParseDocumentResult> {
    let parsed;
    try {
      parsed = parseRawDocument(document.rawText, document.format);
    } catch (error) {
      if (error instanceof DocumentParseError) {
        throw new ImportServiceError(`Failed to parse document "${document.id}": ${error.message}`, error);
      }
      throw this.wrap(error, `Failed to parse document "${document.id}"`);
    }

    // Re-verify the offset invariant against the stored raw text before writing.
    for (const section of parsed.sections) {
      if (document.rawText.slice(section.start, section.end) !== section.text) {
        throw new ImportServiceError(
          `Parser produced a mis-aligned section for document "${document.id}" (order ${section.order}); aborting.`,
        );
      }
    }

    const timestamp = now();
    // Assign ids first so parentIndex can be translated to parentId.
    const ids = parsed.sections.map(() => createDocumentSectionId());
    const sections: DocumentSection[] = parsed.sections.map((section, index) => {
      const parentId = section.parentIndex >= 0 ? ids[section.parentIndex] : null;
      return {
        id: ids[index],
        projectId,
        documentId: document.id,
        parentId,
        level: section.level,
        title: section.title,
        order: section.order,
        start: section.start,
        end: section.end,
        text: section.text,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });

    const updatedDocument: SourceDocument = {
      ...document,
      status: 'parsed',
      parsedAt: timestamp,
      parsedTextHash: rawTextHash,
      structureConfirmedAt: null, // a fresh structure is, by definition, unconfirmed
      updatedAt: timestamp,
    };

    try {
      await this.db.transaction(
        'rw',
        this.db.sourceDocuments,
        this.db.documentSections,
        async () => {
          // Remove any previous sections (stale) so we never accumulate a second set.
          const previous = await this.repository.listSectionsByDocument(document.id);
          for (const old of previous) {
            if (old.projectId === projectId) await this.repository.deleteSection(old.id);
          }
          if (sections.length > 0) await this.repository.bulkCreateSections(sections);
          await this.repository.updateDocument(updatedDocument);
        },
      );
    } catch (error) {
      throw this.wrap(error, `Failed to persist parsed structure of document "${document.id}"`);
    }

    return { document: updatedDocument, sections, parsed: true, sectionCount: sections.length };
  }

  /* ------------------------------- Sections ----------------------------- */

  /** All sections of a document, ordered, scoped to `projectId`. */
  async getSections(projectId: string, documentId: string): Promise<DocumentSection[]> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    try {
      return await this.repository.listSectionsByDocument(documentId);
    } catch (error) {
      throw this.wrap(error, `Failed to list sections of document "${documentId}"`);
    }
  }

  /** Returns one section when it belongs to `projectId`, else null. */
  async getSection(projectId: string, sectionId: string): Promise<DocumentSection | null> {
    try {
      const section = await this.repository.getSectionById(sectionId);
      if (!section || section.projectId !== projectId) return null;
      return section;
    } catch (error) {
      throw this.wrap(error, `Failed to load section "${sectionId}"`);
    }
  }

  /**
   * Updates a single section's STRUCTURE (title / level / parent).
   *
   * - Never touches `text`, `start`, `end` or `rawText` (structure metadata only).
   * - Title/level/parent changes are validated (no cross-document parent, no
   *   cycle, strictly increasing level rank, non-leaf needs a title).
   * - Invalidates the document's structure confirmation (it is now user-edited).
   */
  async updateSection(
    projectId: string,
    sectionId: string,
    input: UpdateSectionInput,
  ): Promise<DocumentSection> {
    const section = await this.getSection(projectId, sectionId);
    if (!section) throw new ImportNotFoundError(`Section "${sectionId}"`);
    const siblings = await this.repository.listSectionsByDocument(section.documentId);

    const nextLevel = input.level ?? section.level;
    const nextParentId = input.parentId !== undefined ? input.parentId : section.parentId;
    const nextTitle = input.title !== undefined ? input.title : section.title;

    // Validate the resulting tree BEFORE writing anything.
    this.validateTitle(nextLevel, nextTitle);
    this.validateParent(section, nextParentId, siblings, nextLevel);

    const timestamp = now();
    const updated: DocumentSection = {
      ...section,
      level: nextLevel,
      parentId: nextParentId,
      title: nextTitle,
      updatedAt: timestamp,
    };

    try {
      await this.db.transaction('rw', this.db.documentSections, this.db.sourceDocuments, async () => {
        await this.repository.updateSection(updated);
        await this.clearConfirmation(section.documentId);
      });
      return updated;
    } catch (error) {
      throw this.wrap(error, `Failed to update section "${sectionId}"`);
    }
  }

  /**
   * Reparents a section (convenience wrapper over `updateSection`).
   *
   * Only the section's `parentId` changes; `level` and the document-wide `order`
   * sequence are left untouched. Callers that want a specific position within
   * the new sibling group should call `reorderSections` afterwards. Sibling
   * display order is derived from the document-wide `order` by grouping on
   * `parentId`, so moving a node never silently reorders other nodes.
   */
  async moveSection(
    projectId: string,
    sectionId: string,
    newParentId: string | null,
  ): Promise<DocumentSection> {
    const section = await this.getSection(projectId, sectionId);
    if (!section) throw new ImportNotFoundError(`Section "${sectionId}"`);
    return this.updateSection(projectId, sectionId, { parentId: newParentId });
  }

  /**
   * Reassigns the sibling order of a document's sections.
   *
   * `orderedIds` must contain EVERY section id of the document exactly once; the
   * array index becomes the new `order`. Validates membership (no foreign ids,
   * no missing/duplicate ids) then writes all updated rows in one transaction.
   * Invalidates structure confirmation.
   */
  async reorderSections(
    projectId: string,
    documentId: string,
    orderedIds: string[],
  ): Promise<DocumentSection[]> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    const sections = await this.repository.listSectionsByDocument(documentId);
    const byId = new Map(sections.map((s) => [s.id, s]));

    if (orderedIds.length !== sections.length) {
      throw new ImportConflictError(
        'invalid-structure',
        `reorderSections expects every section of the document (${sections.length}); got ${orderedIds.length}.`,
      );
    }
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (!byId.has(id)) {
        throw new ImportConflictError('invalid-structure', `Section "${id}" does not belong to document "${documentId}".`);
      }
      if (seen.has(id)) {
        throw new ImportConflictError('invalid-structure', `Section "${id}" appears more than once in the new order.`);
      }
      seen.add(id);
    }

    const timestamp = now();
    const updated = orderedIds.map((id, index) => ({
      ...(byId.get(id) as DocumentSection),
      order: index,
      updatedAt: timestamp,
    }));

    try {
      await this.db.transaction('rw', this.db.documentSections, this.db.sourceDocuments, async () => {
        // Bulk write; the repository has no bulk update, so update one by one
        // inside the single transaction (atomic w.r.t. the whole reorder).
        for (const section of updated) {
          await this.repository.updateSection(section);
        }
        await this.clearConfirmation(documentId);
      });
      return updated.sort((a, b) => a.order - b.order);
    } catch (error) {
      throw this.wrap(error, `Failed to reorder sections of document "${documentId}"`);
    }
  }

  /* ------------------------------ Confirmation -------------------------- */

  /**
   * Marks the document's CURRENT structure as user-confirmed.
   *
   * Preconditions: the document must be parsed and have at least one section.
   * Records `structureConfirmedAt` (idempotent — re-confirming refreshes the
   * timestamp). This ONLY confirms the `DocumentSection` tree; it never creates
   * real Volume/Chapter/Scene records.
   */
  async confirmStructure(projectId: string, documentId: string): Promise<SourceDocument> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    if (document.status === 'imported') {
      throw new ImportConflictError('not-parsed', `Document "${documentId}" has not been parsed yet; parse it before confirming.`);
    }
    const sections = await this.repository.listSectionsByDocument(documentId);
    if (sections.length === 0) {
      throw new ImportConflictError('invalid-structure', `Document "${documentId}" has no sections to confirm.`);
    }
    const timestamp = now();
    const updated: SourceDocument = {
      ...document,
      structureConfirmedAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      return await this.repository.updateDocument(updated);
    } catch (error) {
      throw this.wrap(error, `Failed to confirm structure of document "${documentId}"`);
    }
  }

  /** Whether the document's current structure has been confirmed by the user. */
  async isStructureConfirmed(projectId: string, documentId: string): Promise<boolean> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    return document.structureConfirmedAt != null;
  }

  /**
   * Returns the sections ONLY if the structure is confirmed AND parsed — i.e.
   * the "official" structural input for a future extraction run. Throws when the
   * structure is not yet confirmed, so unconfirmed structure can never be used
   * as extraction input.
   */
  async getConfirmedSections(projectId: string, documentId: string): Promise<DocumentSection[]> {
    const document = await this.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    if (document.structureConfirmedAt == null) {
      throw new ImportConflictError(
        'structure-confirmed',
        `Document "${documentId}" structure is not confirmed; confirm it before using it as extraction input.`,
      );
    }
    return this.getSections(projectId, documentId);
  }

  /* ------------------------------- helpers ------------------------------ */

  /**
   * Serialises parse operations for a single document.
   *
   * Chains `operation` after any in-flight parse of the SAME document id, so two
   * concurrent `parseDocument`/`reparseDocument` calls can never both observe a
   * pre-parse state and write duplicate sections: the second call runs only
   * after the first commits, then hits the idempotent short-circuit. The lock
   * entry is removed once the chain settles (success or failure) so the map does
   * not grow unbounded.
   */
  private withParseLock<T>(documentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.parseLocks.get(documentId) ?? Promise.resolve();
    // Run after `previous` settles, regardless of whether it resolved or rejected.
    const run = previous.then(
      () => operation(),
      () => operation(),
    );
    // Store a settled-safe tail so the map always tracks the latest completion,
    // never a rejected promise (which would otherwise warn as unhandled).
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.parseLocks.set(documentId, tail);
    void tail.then(() => {
      // Only clear if no newer operation has replaced this entry.
      if (this.parseLocks.get(documentId) === tail) this.parseLocks.delete(documentId);
    });
    return run;
  }

  /** Ensures the project exists; throws a not-found style error otherwise. */
  private async requireProject(projectId: string, action: string): Promise<void> {
    const exists = await this.projectService.projectExists(projectId);
    if (!exists) {
      throw new ImportServiceError(`Cannot ${action}: project "${projectId}" was not found.`);
    }
  }

  /** Clears `structureConfirmedAt` on a document (used after structural edits). */
  private async clearConfirmation(documentId: string): Promise<void> {
    const document = await this.repository.getDocumentById(documentId);
    if (!document || document.structureConfirmedAt == null) return;
    const timestamp = now();
    await this.repository.updateDocument({ ...document, structureConfirmedAt: null, updatedAt: timestamp });
  }

  /** Collects section ids of a document that are referenced by extraction records. */
  private async findReferencedSectionIds(projectId: string, documentId: string): Promise<Set<string>> {
    const extractions = await this.repository.listExtractionsByDocument(documentId);
    const ids = new Set<string>();
    for (const record of extractions) {
      if (record.projectId !== projectId) continue;
      for (const evidence of record.evidence) ids.add(evidence.sectionId);
    }
    return ids;
  }

  /** A non-leaf section must carry a non-empty title; paragraphs may be blank. */
  private validateTitle(level: DocumentSectionLevel, title: string): void {
    if (level !== 'paragraph' && title.trim().length === 0) {
      throw new ImportConflictError('invalid-structure', `A "${level}" section must have a non-empty title.`);
    }
  }

  /**
   * Validates a proposed parent for `section`.
   *
   * Rejects: a parent in another document, self-parenting, a cycle (the new
   * parent being the section or one of its descendants), and a level that does
   * not strictly outrank the parent's level.
   */
  private validateParent(
    section: DocumentSection,
    nextParentId: string | null,
    siblings: DocumentSection[],
    nextLevel: DocumentSectionLevel,
  ): void {
    if (nextParentId === null) return;
    if (nextParentId === section.id) {
      throw new ImportConflictError('invalid-structure', `Section "${section.id}" cannot be its own parent.`);
    }
    const byId = new Map(siblings.map((s) => [s.id, s]));
    const parent = byId.get(nextParentId);
    if (!parent) {
      throw new ImportConflictError(
        'invalid-structure',
        `Parent "${nextParentId}" does not belong to document "${section.documentId}".`,
      );
    }
    // Level must strictly increase down the tree.
    if (LEVEL_RANK[nextLevel] <= LEVEL_RANK[parent.level]) {
      throw new ImportConflictError(
        'invalid-structure',
        `A "${nextLevel}" section cannot be a child of a "${parent.level}" section (level must increase).`,
      );
    }
    // Cycle check: walk up the proposed parent chain; if we reach `section`, it's a cycle.
    let cursor: DocumentSection | undefined = parent;
    const guard = new Set<string>();
    while (cursor) {
      if (cursor.id === section.id) {
        throw new ImportConflictError('invalid-structure', `Reparenting "${section.id}" under "${nextParentId}" would create a cycle.`);
      }
      if (guard.has(cursor.id)) break; // defensive: pre-existing cycle in data
      guard.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ImportServiceError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ImportServiceError(message, error);
  }
}
