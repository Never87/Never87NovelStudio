import type { Table } from 'dexie';
import type { NovelStudioDb } from '@/db';
import { getDb } from '@/db';
import { SourceDocumentSchema, DocumentSectionSchema } from '@/schemas/document';
import { ExtractionRecordSchema } from '@/schemas/extraction';
import type { DocumentSection, ExtractionRecord, SourceDocument } from '@/types';
import { ProjectRepositoryError, ProjectValidationError } from './project-repository';

/**
 * Data-access layer for the import pipeline (P8).
 *
 * Pure persistence over the three P8 tables: `sourceDocuments`,
 * `documentSections`, `extractionRecords`. No id/timestamp derivation and no
 * business rules — those live in the (later) Import/Extraction services. Every
 * write is validated against its Zod schema; every read is validated back, the
 * same strategy as every other repository.
 *
 * ## Idempotency
 *
 * `findExtractionByDedupeKey` backs the idempotent-write lookup. Dexie cannot
 * enforce a UNIQUE constraint on a non-primary-key index, so uniqueness is
 * enforced by the SERVICE using a single readwrite transaction:
 * "find-by-key → update else insert". These repository methods are the building
 * blocks for that; they never assume the index alone guarantees uniqueness.
 *
 * ## Isolation
 *
 * Every list/delete is scoped by `projectId`, so one project's documents can
 * never be read or removed through another project's id. Cascade deletion runs
 * child-first (extraction → sections → documents) to respect referential order.
 */
export class ImportRepository {
  private readonly documents: Table<SourceDocument, string>;
  private readonly sections: Table<DocumentSection, string>;
  private readonly extractions: Table<ExtractionRecord, string>;

  constructor(database: NovelStudioDb = getDb()) {
    this.documents = database.sourceDocuments;
    this.sections = database.documentSections;
    this.extractions = database.extractionRecords;
  }

  /* ------------------------------ Documents ----------------------------- */

  async getDocumentById(id: string): Promise<SourceDocument | null> {
    let row: SourceDocument | undefined;
    try {
      row = await this.documents.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read source document "${id}"`, error);
    }
    if (row === undefined) return null;
    assertDocumentReadable(row, `Failed to read source document "${id}"`);
    return row;
  }

  /** All documents of `projectId`, most recently updated first. */
  async listDocumentsByProject(projectId: string): Promise<SourceDocument[]> {
    let rows: SourceDocument[];
    try {
      rows = await this.documents.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list source documents of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertDocumentReadable(row, `Failed to list source documents of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(byUpdatedDesc);
  }

  /** Inserts a document. Uses `add()` so an existing id is never overwritten. */
  async createDocument(document: SourceDocument): Promise<SourceDocument> {
    const validated = validateDocument(document);
    try {
      await this.documents.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create source document "${document.id}"`, error);
    }
  }

  /** Replaces an existing document. Fails when the id does not exist. */
  async updateDocument(document: SourceDocument): Promise<SourceDocument> {
    const validated = validateDocument(document);
    try {
      const existing = await this.documents.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Source document "${validated.id}" was not found`);
      await this.documents.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update source document "${document.id}"`, error);
    }
  }

  async deleteDocument(id: string): Promise<void> {
    try {
      const existing = await this.documents.get(id);
      if (!existing) throw new ProjectRepositoryError(`Source document "${id}" was not found`);
      await this.documents.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete source document "${id}"`, error);
    }
  }

  /* ------------------------------ Sections ------------------------------ */

  async getSectionById(id: string): Promise<DocumentSection | null> {
    let row: DocumentSection | undefined;
    try {
      row = await this.sections.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read document section "${id}"`, error);
    }
    if (row === undefined) return null;
    assertSectionReadable(row, `Failed to read document section "${id}"`);
    return row;
  }

  /** All sections of a document, ordered by `order` ascending. */
  async listSectionsByDocument(documentId: string): Promise<DocumentSection[]> {
    let rows: DocumentSection[];
    try {
      rows = await this.sections.where('[documentId+order]').between([documentId, -Infinity], [documentId, Infinity]).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list sections of document "${documentId}"`, error);
    }
    rows.forEach((row, index) =>
      assertSectionReadable(row, `Failed to list sections of document "${documentId}" (record at position ${index})`),
    );
    return rows.sort((a, b) => a.order - b.order);
  }

  /** All sections of a project (any document), ordered by document then order. */
  async listSectionsByProject(projectId: string): Promise<DocumentSection[]> {
    let rows: DocumentSection[];
    try {
      rows = await this.sections.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list sections of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertSectionReadable(row, `Failed to list sections of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort((a, b) => (a.documentId === b.documentId ? a.order - b.order : a.documentId < b.documentId ? -1 : 1));
  }

  async createSection(section: DocumentSection): Promise<DocumentSection> {
    const validated = validateSection(section);
    try {
      await this.sections.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create document section "${section.id}"`, error);
    }
  }

  /** Bulk-inserts sections inside ONE transaction (no partial writes on failure). */
  async bulkCreateSections(sections: DocumentSection[]): Promise<DocumentSection[]> {
    const validated = sections.map(validateSection);
    try {
      await this.sections.db.transaction('rw', this.sections, async () => {
        await this.sections.bulkAdd(validated);
      });
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create ${sections.length} document sections`, error);
    }
  }

  async updateSection(section: DocumentSection): Promise<DocumentSection> {
    const validated = validateSection(section);
    try {
      const existing = await this.sections.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Document section "${validated.id}" was not found`);
      await this.sections.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update document section "${section.id}"`, error);
    }
  }

  async deleteSection(id: string): Promise<void> {
    try {
      const existing = await this.sections.get(id);
      if (!existing) throw new ProjectRepositoryError(`Document section "${id}" was not found`);
      await this.sections.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete document section "${id}"`, error);
    }
  }

  /* ----------------------------- Extractions ---------------------------- */

  async getExtractionById(id: string): Promise<ExtractionRecord | null> {
    let row: ExtractionRecord | undefined;
    try {
      row = await this.extractions.get(id);
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to read extraction "${id}"`, error);
    }
    if (row === undefined) return null;
    assertExtractionReadable(row, `Failed to read extraction "${id}"`);
    return row;
  }

  /** All extractions of `projectId`, most recently updated first. */
  async listExtractionsByProject(projectId: string): Promise<ExtractionRecord[]> {
    let rows: ExtractionRecord[];
    try {
      rows = await this.extractions.where('projectId').equals(projectId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list extractions of project "${projectId}"`, error);
    }
    rows.forEach((row, index) =>
      assertExtractionReadable(row, `Failed to list extractions of project "${projectId}" (record at position ${index})`),
    );
    return rows.sort(byUpdatedDesc);
  }

  /** All extractions of a single document, ordered by creation. */
  async listExtractionsByDocument(documentId: string): Promise<ExtractionRecord[]> {
    let rows: ExtractionRecord[];
    try {
      rows = await this.extractions.where('documentId').equals(documentId).toArray();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to list extractions of document "${documentId}"`, error);
    }
    rows.forEach((row, index) =>
      assertExtractionReadable(row, `Failed to list extractions of document "${documentId}" (record at position ${index})`),
    );
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Finds an extraction by its idempotency key within a project.
   *
   * Backed by the compound `[projectId+dedupeKey]` index. Returns the first match
   * (there should never be more than one when writes go through the service's
   * transactional upsert).
   */
  async findExtractionByDedupeKey(projectId: string, dedupeKey: string): Promise<ExtractionRecord | null> {
    let row: ExtractionRecord | undefined;
    try {
      row = await this.extractions.where('[projectId+dedupeKey]').equals([projectId, dedupeKey]).first();
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to look up extraction by dedupe key "${dedupeKey}"`, error);
    }
    if (row === undefined) return null;
    assertExtractionReadable(row, `Failed to read extraction by dedupe key "${dedupeKey}"`);
    return row;
  }

  async createExtraction(record: ExtractionRecord): Promise<ExtractionRecord> {
    const validated = validateExtraction(record);
    try {
      await this.extractions.add(validated);
      return validated;
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to create extraction "${record.id}"`, error);
    }
  }

  async updateExtraction(record: ExtractionRecord): Promise<ExtractionRecord> {
    const validated = validateExtraction(record);
    try {
      const existing = await this.extractions.get(validated.id);
      if (!existing) throw new ProjectRepositoryError(`Extraction "${validated.id}" was not found`);
      await this.extractions.put(validated);
      return validated;
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to update extraction "${record.id}"`, error);
    }
  }

  async deleteExtraction(id: string): Promise<void> {
    try {
      const existing = await this.extractions.get(id);
      if (!existing) throw new ProjectRepositoryError(`Extraction "${id}" was not found`);
      await this.extractions.delete(id);
    } catch (error) {
      if (error instanceof ProjectRepositoryError) throw error;
      throw new ProjectRepositoryError(`Failed to delete extraction "${id}"`, error);
    }
  }

  /* --------------------------- Cascade deletes -------------------------- */

  /**
   * Deletes ALL P8 rows of a project: extractions → sections → documents.
   *
   * Child-first order ensures we never leave orphaned sections/extractions.
   * Runs inside a single transaction so a failure can't half-delete. Idempotent
   * (returns the counts removed).
   */
  async deleteByProjectId(projectId: string): Promise<{
    documents: number;
    sections: number;
    extractions: number;
  }> {
    try {
      return await this.documents.db.transaction('rw', this.extractions, this.sections, this.documents, async () => {
        const extractions = await this.extractions.where('projectId').equals(projectId).delete();
        const sections = await this.sections.where('projectId').equals(projectId).delete();
        const documents = await this.documents.where('projectId').equals(projectId).delete();
        return { documents, sections, extractions };
      });
    } catch (error) {
      throw new ProjectRepositoryError(`Failed to delete import data of project "${projectId}"`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Most recently updated first, id-stable on ties. */
function byUpdatedDesc<T extends { updatedAt: number; id: string }>(a: T, b: T): number {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
  return b.updatedAt - a.updatedAt;
}

function validateDocument(document: SourceDocument): SourceDocument {
  const result = SourceDocumentSchema.safeParse(document);
  if (!result.success) {
    throw new ProjectValidationError(
      `Source document "${String(document?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function validateSection(section: DocumentSection): DocumentSection {
  const result = DocumentSectionSchema.safeParse(section);
  if (!result.success) {
    throw new ProjectValidationError(
      `Document section "${String(section?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function validateExtraction(record: ExtractionRecord): ExtractionRecord {
  const result = ExtractionRecordSchema.safeParse(record);
  if (!result.success) {
    throw new ProjectValidationError(
      `Extraction "${String(record?.id ?? '<unknown>')}" is invalid and was not written`,
      result.error.issues,
      result.error,
    );
  }
  return result.data;
}

function assertDocumentReadable(document: SourceDocument, context: string): void {
  const result = SourceDocumentSchema.safeParse(document);
  if (!result.success) {
    const id = String((document as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}

function assertSectionReadable(section: DocumentSection, context: string): void {
  const result = DocumentSectionSchema.safeParse(section);
  if (!result.success) {
    const id = String((section as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}

function assertExtractionReadable(record: ExtractionRecord, context: string): void {
  const result = ExtractionRecordSchema.safeParse(record);
  if (!result.success) {
    const id = String((record as { id?: unknown } | null)?.id ?? '<unknown>');
    throw new ProjectRepositoryError(`${context}: record "${id}" is malformed and was not returned`, result.error);
  }
}
