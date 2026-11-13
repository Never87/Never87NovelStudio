import { ZodError } from 'zod';
import { now } from '@/utils/date';
import type { DocumentEvidence, DocumentSection, ExtractionKind, ExtractionRecord, SourceDocument } from '@/types';
import { ExtractionRecordSchema, buildDedupeKey } from '@/schemas/extraction';
import { ImportRepository } from '@/repositories/import-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ImportService, ImportServiceError, ImportNotFoundError } from './import-service';
import { ExtractionService, ExtractionServiceError } from './extraction-service';
import { ProjectServiceError } from './project-service';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Base class for Extraction Review Center business errors. */
export class ReviewServiceError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ReviewServiceError';
  }
}

/** The extraction record was not found within the requested project. */
export class ReviewNotFoundError extends ReviewServiceError {
  constructor(id: string) {
    super(`Extraction "${id}" was not found in this project`);
    this.name = 'ReviewNotFoundError';
  }
}

/**
 * A lifecycle/consistency rule blocked the operation. Carries a machine-readable
 * `reason` so callers/tests can assert on the specific failure.
 *
 * Reasons:
 *   - `not-pending`         — the record is not in a state that allows the write.
 *   - `invalid-transition`  — an explicit state-transition violation.
 *   - `cross-project`       — a referenced record belongs to another project.
 *   - `invalid-evidence`    — an edit/merge supplied stale/invalid evidence.
 *   - `merge-self`          — merge source === target.
 *   - `merge-cycle`         — merge would corrupt the merge chain.
 *   - `merge-target-status` — target is not eligible (rejected / merged).
 *   - `invalid-fields`      — Zod validation of the resulting record failed.
 */
export class ReviewValidationError extends ReviewServiceError {
  readonly reason:
    | 'not-pending'
    | 'invalid-transition'
    | 'cross-project'
    | 'invalid-evidence'
    | 'merge-self'
    | 'merge-cycle'
    | 'merge-target-status'
    | 'invalid-fields';

  constructor(reason: ReviewValidationError['reason'], message: string) {
    super(message);
    this.name = 'ReviewValidationError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Public input/output shapes                                                 */
/* -------------------------------------------------------------------------- */

/** Filters for the review queue. All optional; combined with AND. */
export interface ReviewQueueFilters {
  /** Restrict to a single review status (or `'all'`). Defaults to `pending` only. */
  status?: ExtractionRecord['reviewStatus'] | 'all';
  /** Restrict to a single kind. */
  kind?: ExtractionKind;
  /** Restrict to a single source document. */
  documentId?: string;
  /** Restrict to a single origin (`fact` / `ai` / `manual`). */
  origin?: ExtractionRecord['origin'];
  /** Case-insensitive title/summary substring. */
  search?: string;
}

/** One entry in the review queue (record + evidence-validity assessment). */
export interface ReviewQueueItem {
  record: ExtractionRecord;
  /** Whether EVERY evidence locator still resolves against the current raw text. */
  evidenceValid: boolean;
}

/** The full detail payload for the review detail view. */
export interface ReviewDetail {
  record: ExtractionRecord;
  /** The source document (may be null if it was deleted). */
  document: SourceDocument | null;
  /** The sections cited by the record's evidence (resolved, ordered). */
  sections: DocumentSection[];
  /** Per-evidence validity (never repairs; only reports). */
  evidence: ReviewedEvidence[];
  /** True when EVERY evidence locator still resolves against the raw text. */
  evidenceValid: boolean;
}

/** A single evidence locator reviewed against the current document raw text. */
export interface ReviewedEvidence {
  evidence: DocumentEvidence;
  section: DocumentSection | null;
  /** The exact text the evidence addresses in the CURRENT section, or null. */
  slice: string | null;
  /** Whether the locator still resolves to its quote against the raw text. */
  valid: boolean;
  /** A short human-readable reason when invalid (never mutates the evidence). */
  problem?: string;
}

/** Editable candidate fields on a still-pending extraction. */
export interface UpdatePendingInput {
  kind?: ExtractionKind;
  title?: string;
  summary?: string;
  body?: string;
  tags?: string[];
  /**
   * When provided, REPLACES the evidence set. Each hint is re-resolved against
   * the CURRENT confirmed structure and raw text; invalid hints are rejected.
   */
  evidence?: Array<{ sectionId: string; quote: string; start?: number; end?: number }>;
}

/** Result of confirming, rejecting, merging or restoring a record. */
export interface ReviewActionResult {
  record: ExtractionRecord;
  /** True when the call was an idempotent no-op (already in the target state). */
  alreadyApplied: boolean;
}

/** Result of a merge (source folded into target). */
export interface MergeResult {
  /** The source record, now `merged` and carrying its audit trail. */
  source: ExtractionRecord;
  /** The target record, with the source's validated evidence appended. */
  target: ExtractionRecord;
  /** True when the merge was an idempotent no-op (already merged this way). */
  alreadyApplied: boolean;
}

/* -------------------------------------------------------------------------- */
/* ReviewService                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Business layer for the Extraction Review Center (P8 Batch 4).
 *
 * ## Responsibility
 *
 * Owns the REVIEW LIFECYCLE of `ExtractionRecord`s that the P8 Batch-3
 * `ExtractionService` produces. It does NOT re-implement extraction or evidence
 * resolution: it composes `ExtractionService` (for evidence re-resolution on
 * edits) and `ImportService` (for the current confirmed structure + raw text),
 * and reads/writes through the shared `ImportRepository`.
 *
 * ## Explicit state machine
 *
 *   pending ──confirm──▶ confirmed
 *      │
 *      ├──reject──────────▶ rejected ──restore──▶ pending
 *      │
 *      └──merge(into T)───▶ merged (terminal)
 *
 * Rules:
 *   - ONLY `pending` records may be EDITED (updatePending) or CONFIRMED.
 *   - `confirm`/`reject`/`merge` are IDEMPOTENT: repeating the SAME transition
 *     returns `alreadyApplied: true` (no second write). A DIFFERENT transition
 *     on a record in a terminal/other state throws `invalid-transition`/
 *     `not-pending` — nothing is silently overwritten.
 *   - `restore` (rejected → pending) is supported so a rejected candidate can be
 *     reconsidered; confirmed/merged are NOT restorable.
 *
 * ## Confidence NEVER decides acceptance
 *
 * `confidence` is copied through untouched; no operation reads it to decide.
 *
 * ## Evidence
 *
 * Evidence is PRESERVED on every operation unless the reviewer explicitly edits
 * it. On edit, supplied evidence is re-resolved against the CURRENT confirmed
 * structure and raw text via `ExtractionService`'s validators. The DETAIL view
 * re-validates evidence against the current raw text and marks stale/invalid
 * evidence — it NEVER repairs or relocates it.
 *
 * ## Merge semantics (folding duplicates)
 *
 * Merging folds a duplicate SOURCE extraction into an existing TARGET extraction
 * (NOT into a project entity — that is Project Integration, a later phase):
 *   - both must exist in the SAME project;
 *   - source must be `pending`, target must be `pending` or `confirmed`;
 *   - source !== target;
 *   - the TARGET must not itself be a merged record (chain/cycle guard);
 *   - the source's evidence is re-validated, then APPENDED to the target (deduped
 *     by locator) — the source keeps its OWN evidence as provenance too;
 *   - the source becomes `merged` with `{ targetId, mergedAt, absorbedEvidence }`;
 *     the target keeps its status (merge is one-way, no back-pointer);
 *   - repeating the same merge is idempotent (no duplicate evidence, no rewrite).
 *
 * ## Transactional consistency
 *
 * Every write runs inside ONE Dexie readwrite transaction over the extraction
 * table (`repository.runExtractionTransaction`) — merge (two-row write) included
 * — so a mid-way failure rolls back cleanly and leaves no partial state.
 *
 * ## Project isolation
 *
 * Every read/write is scoped by `projectId`; a record from another project is
 * treated as not-found / cross-project and never touched.
 *
 * This service NEVER writes to Knowledge/Character/World/Chapter/Scene or any
 * project entity.
 */
export class ReviewService {
  private readonly repository: ImportRepository;
  private readonly importService: ImportService;
  private readonly extractionService: ExtractionService;

  constructor(deps: {
    repository?: ImportRepository;
    importService?: ImportService;
    extractionService?: ExtractionService;
  } = {}) {
    this.repository = deps.repository ?? new ImportRepository();
    this.importService = deps.importService ?? new ImportService({ repository: this.repository });
    this.extractionService =
      deps.extractionService ?? new ExtractionService({ repository: this.repository, importService: this.importService });
  }

  /* ------------------------------- Reads --------------------------------- */

  /**
   * The review queue: this project's records (default: `pending` only),
   * newest-first (the repository's order), optionally filtered, each paired with
   * an evidence-validity flag computed against the CURRENT stored raw text.
   */
  async getReviewQueue(projectId: string, filters: ReviewQueueFilters = {}): Promise<ReviewQueueItem[]> {
    const status = filters.status ?? 'pending';
    const all = await this.listProjectExtractions(projectId);

    const filtered = all.filter((record) => {
      if (status !== 'all' && record.reviewStatus !== status) return false;
      if (filters.kind && record.kind !== filters.kind) return false;
      if (filters.documentId && record.documentId !== filters.documentId) return false;
      if (filters.origin && record.origin !== filters.origin) return false;
      if (filters.search) {
        const needle = filters.search.trim().toLowerCase();
        if (needle.length > 0) {
          const hay = `${record.title} ${record.summary}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
      }
      return true;
    });

    // Validate evidence per-record against the current raw text (cached per doc).
    const docCache = new Map<string, { doc: SourceDocument | null; sections: Map<string, DocumentSection> }>();
    const out: ReviewQueueItem[] = [];
    for (const record of filtered) {
      const assessed = await this.assessRecordEvidence(projectId, record, docCache);
      out.push({ record, evidenceValid: assessed });
    }
    return out;
  }

  /**
   * The full detail payload for one record: the record, its source document, the
   * cited sections, and per-evidence validity against the CURRENT raw text.
   */
  async getReviewDetail(projectId: string, extractionId: string): Promise<ReviewDetail> {
    const record = await this.requireExtraction(projectId, extractionId);
    const document = await this.importService.getDocument(projectId, record.documentId);
    if (!document) {
      // Document deleted out from under the record: report evidence as invalid,
      // never crash and never fabricate.
      return {
        record,
        document: null,
        sections: [],
        evidence: record.evidence.map((evidence) => ({
          evidence,
          section: null,
          slice: null,
          valid: false,
          problem: 'Source document no longer exists.',
        })),
        evidenceValid: false,
      };
    }

    const allSections = await this.importService.getSections(projectId, record.documentId);
    const sectionById = new Map(allSections.map((s) => [s.id, s]));
    const evidence = record.evidence.map((ev) =>
      this.reviewEvidence(document, sectionById.get(ev.sectionId) ?? null, ev),
    );
    const citedSectionIds = new Set(record.evidence.map((ev) => ev.sectionId));
    const sections = allSections.filter((s) => citedSectionIds.has(s.id));

    return {
      record,
      document,
      sections,
      evidence,
      evidenceValid: evidence.every((e) => e.valid),
    };
  }

  /* ------------------------- Pending-field editing ----------------------- */

  /**
   * Lists the records eligible to RECEIVE a merge in this project: every record
   * whose status is `pending` or `confirmed` and that is not itself merged,
   * excluding `excludeId`. Used by the reviewer's "Merge into…" picker so a
   * merge can never be aimed at an ineligible target.
   */
  async listMergeCandidates(projectId: string, excludeId: string): Promise<ExtractionRecord[]> {
    const all = await this.listProjectExtractions(projectId);
    return all.filter(
      (record) =>
        record.id !== excludeId &&
        record.merge === undefined &&
        (record.reviewStatus === 'pending' || record.reviewStatus === 'confirmed'),
    );
  }

  /**
   * Edits the editable fields of a PENDING record. Non-pending records are
   * refused (`not-pending`) — confirmed/rejected/merged records are never
   * silently overwritten.
   *
   * Origin, confidence, document reference, evidence provenance (unless
   * evidence is explicitly replaced) and review status are preserved. When
   * `evidence` is supplied it REPLACES the set, re-resolved against the current
   * confirmed structure + raw text (invalid evidence → `invalid-evidence`).
   */
  async updatePendingExtraction(
    projectId: string,
    extractionId: string,
    input: UpdatePendingInput,
  ): Promise<ExtractionRecord> {
    const existing = await this.requireExtraction(projectId, extractionId);
    this.assertPending(existing, 'edit');

    const document = await this.requireDocument(projectId, existing.documentId);

    let evidence: DocumentEvidence[] = existing.evidence;
    if (input.evidence !== undefined) {
      // Reuse ExtractionService's evidence validators (single source of truth).
      evidence = await this.resolveEvidenceForEdit(projectId, document, input.evidence);
    }

    const nextKind = input.kind ?? existing.kind;
    const nextTitle = input.title ?? existing.title;
    const primarySectionId = evidence[0]?.sectionId ?? existing.evidence[0].sectionId;

    const merged: ExtractionRecord = {
      ...existing,
      kind: nextKind,
      title: nextTitle,
      summary: input.summary ?? existing.summary,
      body: input.body ?? existing.body,
      tags: input.tags ?? existing.tags,
      evidence,
      dedupeKey: buildDedupeKey({
        documentId: existing.documentId,
        kind: nextKind,
        title: nextTitle,
        primarySectionId,
      }),
      // origin, confidence, integration, reviewStatus, createdAt, merge: preserved.
      updatedAt: now(),
    };
    this.validateRecord(merged);

    return this.runInTransaction(async () => {
      // Guard against a concurrent transition between the read and the write.
      const current = await this.requireExtraction(projectId, extractionId);
      this.assertPending(current, 'edit');
      return this.repository.updateExtraction(merged);
    });
  }

  /* --------------------------- Confirm / reject -------------------------- */

  /**
   * Confirms a PENDING record. Idempotent: confirming an already-`confirmed`
   * record returns `alreadyApplied: true`. A record in `rejected`/`merged` state
   * cannot be confirmed (`not-pending`).
   */
  async confirmExtraction(projectId: string, extractionId: string): Promise<ReviewActionResult> {
    return this.transitionTo(projectId, extractionId, 'confirmed');
  }

  /**
   * Rejects a PENDING record. Idempotent like `confirmExtraction`. A `confirmed`
   * record cannot be rejected through this call (`not-pending`) — we never
   * silently flip a confirmed decision.
   */
  async rejectExtraction(projectId: string, extractionId: string): Promise<ReviewActionResult> {
    return this.transitionTo(projectId, extractionId, 'rejected');
  }

  /**
   * Restores a REJECTED record back to PENDING. Only `rejected` → `pending` is
   * allowed; any other source state throws `invalid-transition`. Restoring a
   * pending record is an idempotent no-op.
   */
  async restoreRejectedExtraction(projectId: string, extractionId: string): Promise<ReviewActionResult> {
    const record = await this.requireExtraction(projectId, extractionId);
    if (record.reviewStatus === 'pending') return { record, alreadyApplied: true };
    if (record.reviewStatus !== 'rejected') {
      throw new ReviewValidationError(
        'invalid-transition',
        `Only a rejected extraction can be restored to pending (record "${extractionId}" is "${record.reviewStatus}").`,
      );
    }
    return this.runInTransaction(async () => {
      const current = await this.requireExtraction(projectId, extractionId);
      if (current.reviewStatus === 'pending') return { record: current, alreadyApplied: true };
      if (current.reviewStatus !== 'rejected') {
        throw new ReviewValidationError(
          'invalid-transition',
          `Cannot restore "${extractionId}" from "${current.reviewStatus}".`,
        );
      }
      const updated: ExtractionRecord = { ...current, reviewStatus: 'pending', updatedAt: now() };
      this.validateRecord(updated);
      const saved = await this.repository.updateExtraction(updated);
      return { record: saved, alreadyApplied: false };
    });
  }

  /* -------------------------------- Merge -------------------------------- */

  /**
   * Merges a SOURCE pending extraction into a TARGET extraction in the same
   * project, folding the source's validated evidence into the target.
   *
   * See the class documentation for the full merge contract. All validation
   * happens BEFORE any write; the two-row write is transactional.
   */
  async mergeExtractions(projectId: string, sourceId: string, targetId: string): Promise<MergeResult> {
    if (sourceId === targetId) {
      throw new ReviewValidationError('merge-self', 'An extraction cannot be merged into itself.');
    }

    return this.runInTransaction(async () => {
      const source = await this.requireExtraction(projectId, sourceId);
      const target = await this.getExtraction(projectId, targetId);
      if (!target) {
        throw new ReviewValidationError('cross-project', `Merge target "${targetId}" was not found in this project.`);
      }

      // Idempotent: the source is already merged into exactly this target.
      if (source.reviewStatus === 'merged' && source.merge?.targetId === targetId) {
        return { source, target, alreadyApplied: true };
      }

      // Eligible states: source pending; target pending or confirmed.
      if (source.reviewStatus !== 'pending') {
        throw new ReviewValidationError(
          'not-pending',
          `Only a pending extraction can be merged (source "${sourceId}" is "${source.reviewStatus}").`,
        );
      }
      if (target.reviewStatus !== 'pending' && target.reviewStatus !== 'confirmed') {
        throw new ReviewValidationError(
          'merge-target-status',
          `A merge target must be pending or confirmed (target "${targetId}" is "${target.reviewStatus}").`,
        );
      }

      // Chain / cycle guard: the target must not itself be a merged record.
      if (target.merge !== undefined) {
        throw new ReviewValidationError(
          'merge-cycle',
          `Target "${targetId}" is itself merged and cannot receive another merge (would corrupt the merge chain).`,
        );
      }

      // Re-validate the source evidence against the CURRENT raw text before
      // absorbing it, so we never copy stale locators into the target.
      const document = await this.requireDocument(projectId, source.documentId);
      const absorbed = await this.revalidateSourceEvidence(projectId, document, source);

      // Build the target: existing evidence + freshly-validated source evidence,
      // deduped by locator. Never duplicates on a repeated merge.
      const targetEvidence = dedupeEvidence([...target.evidence, ...absorbed]);
      const nextTarget: ExtractionRecord = { ...target, evidence: targetEvidence, updatedAt: now() };
      this.validateRecord(nextTarget);

      // Build the source: merged + audit trail. Evidence preserved on the source.
      const nextSource: ExtractionRecord = {
        ...source,
        reviewStatus: 'merged',
        merge: { targetId, mergedAt: now(), absorbedEvidence: absorbed.length },
        updatedAt: now(),
      };
      this.validateRecord(nextSource);

      // Two-row write, atomic. Update source first, target second (order does
      // not matter for atomicity; both roll back together on failure).
      const savedSource = await this.repository.updateExtraction(nextSource);
      const savedTarget = await this.repository.updateExtraction(nextTarget);
      return { source: savedSource, target: savedTarget, alreadyApplied: false };
    });
  }

  /* ------------------------------- helpers ------------------------------- */

  /** Shared confirm/reject implementation with the idempotence rules above. */
  private async transitionTo(
    projectId: string,
    extractionId: string,
    target: 'confirmed' | 'rejected',
  ): Promise<ReviewActionResult> {
    const record = await this.requireExtraction(projectId, extractionId);

    // Already in the target state → idempotent no-op.
    if (record.reviewStatus === target) return { record, alreadyApplied: true };
    // Only pending may transition; everything else is an explicit conflict.
    if (record.reviewStatus !== 'pending') {
      throw new ReviewValidationError(
        'not-pending',
        `Extraction "${extractionId}" is "${record.reviewStatus}" and cannot be ${target}.`,
      );
    }

    return this.runInTransaction(async () => {
      const current = await this.requireExtraction(projectId, extractionId);
      if (current.reviewStatus === target) return { record: current, alreadyApplied: true };
      if (current.reviewStatus !== 'pending') {
        throw new ReviewValidationError(
          'not-pending',
          `Extraction "${extractionId}" is "${current.reviewStatus}" and cannot be ${target}.`,
        );
      }
      const updated: ExtractionRecord = { ...current, reviewStatus: target, updatedAt: now() };
      // `merge` must be absent for non-merged states (schema invariant).
      if (updated.merge !== undefined) delete (updated as { merge?: unknown }).merge;
      this.validateRecord(updated);
      const saved = await this.repository.updateExtraction(updated);
      return { record: saved, alreadyApplied: false };
    });
  }

  /**
   * Resolves caller-supplied evidence for an edit against the CURRENT confirmed
   * structure, delegating to `ExtractionService.resolveEvidenceForReview` so the
   * resolution algorithm (quote matching, offset validation, cross-document /
   * cross-project checks) has a SINGLE implementation shared with extraction.
   */
  private async resolveEvidenceForEdit(
    projectId: string,
    document: SourceDocument,
    hints: Array<{ sectionId: string; quote: string; start?: number; end?: number }>,
  ): Promise<DocumentEvidence[]> {
    return this.extractionService.resolveEvidenceForReview(projectId, document, hints);
  }

  /**
   * Re-validates the SOURCE's evidence against the current raw text and returns
   * the subset that still resolves (absorbed into the target). A source whose
   * evidence is entirely stale cannot be merged (nothing valid to absorb).
   */
  private async revalidateSourceEvidence(
    projectId: string,
    sourceDocument: SourceDocument,
    source: ExtractionRecord,
  ): Promise<DocumentEvidence[]> {
    const sourceSections = await this.importService.getSections(projectId, source.documentId);
    const sourceSectionById = new Map(sourceSections.map((s) => [s.id, s]));

    const absorbed: DocumentEvidence[] = [];
    for (const ev of source.evidence) {
      const section = sourceSectionById.get(ev.sectionId);
      if (!section) continue; // section gone → can't absorb
      if (!evidenceStillValid(sourceDocument, section, ev)) continue; // stale → skip
      absorbed.push(ev);
    }
    if (absorbed.length === 0) {
      throw new ReviewValidationError(
        'invalid-evidence',
        `Source extraction "${source.id}" has no evidence that still resolves against the current document; nothing to merge.`,
      );
    }
    return absorbed;
  }

  /** Assesses EVERY evidence locator of a record (used by the queue). */
  private async assessRecordEvidence(
    projectId: string,
    record: ExtractionRecord,
    cache: Map<string, { doc: SourceDocument | null; sections: Map<string, DocumentSection> }>,
  ): Promise<boolean> {
    let entry = cache.get(record.documentId);
    if (!entry) {
      const doc = await this.importService.getDocument(projectId, record.documentId);
      const sections = doc ? await this.importService.getSections(projectId, record.documentId) : [];
      entry = { doc, sections: new Map(sections.map((s) => [s.id, s])) };
      cache.set(record.documentId, entry);
    }
    if (!entry.doc) return false;
    const loaded = entry;
    const rawDoc = loaded.doc as SourceDocument;
    return record.evidence.every((ev) => {
      const section = loaded.sections.get(ev.sectionId) ?? null;
      return section ? evidenceStillValid(rawDoc, section, ev) : false;
    });
  }

  /** Builds a single reviewed-evidence row (never repairs the evidence). */
  private reviewEvidence(
    document: SourceDocument,
    section: DocumentSection | null,
    evidence: DocumentEvidence,
  ): ReviewedEvidence {
    if (!section) {
      return { evidence, section: null, slice: null, valid: false, problem: 'Cited section no longer exists.' };
    }
    const inRange = evidence.start >= 0 && evidence.end <= section.text.length && evidence.end >= evidence.start;
    if (!inRange) {
      return {
        evidence,
        section,
        slice: null,
        valid: false,
        problem: `Offsets [${evidence.start}, ${evidence.end}) are outside section bounds (${section.text.length}).`,
      };
    }
    const slice = section.text.slice(evidence.start, evidence.end);
    const rawSlice = document.rawText.slice(section.start + evidence.start, section.start + evidence.end);
    const quoteMatches = evidence.quote === undefined ? true : evidence.quote === slice && rawSlice === slice;
    if (!quoteMatches) {
      return {
        evidence,
        section,
        slice,
        valid: false,
        problem: 'Stored evidence no longer matches the current section text (structure/text changed).',
      };
    }
    return { evidence, section, slice, valid: true };
  }

  private async listProjectExtractions(projectId: string): Promise<ExtractionRecord[]> {
    try {
      return await this.repository.listExtractionsByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list extractions of project "${projectId}"`);
    }
  }

  private async getExtraction(projectId: string, id: string): Promise<ExtractionRecord | null> {
    try {
      const record = await this.repository.getExtractionById(id);
      if (!record || record.projectId !== projectId) return null;
      return record;
    } catch (error) {
      throw this.wrap(error, `Failed to load extraction "${id}"`);
    }
  }

  private async requireExtraction(projectId: string, id: string): Promise<ExtractionRecord> {
    const record = await this.getExtraction(projectId, id);
    if (!record) throw new ReviewNotFoundError(id);
    return record;
  }

  private async requireDocument(projectId: string, documentId: string): Promise<SourceDocument> {
    const document = await this.importService.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    return document;
  }

  private assertPending(record: ExtractionRecord, action: string): void {
    if (record.reviewStatus !== 'pending') {
      throw new ReviewValidationError(
        'not-pending',
        `Cannot ${action} extraction "${record.id}": it is "${record.reviewStatus}", not pending.`,
      );
    }
  }

  private validateRecord(record: ExtractionRecord): void {
    const result = ExtractionRecordSchema.safeParse(record);
    if (!result.success) {
      throw new ReviewValidationError(
        'invalid-fields',
        `Extraction is invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
  }

  /** Runs `fn` inside one extraction-table readwrite transaction (atomic writes). */
  private runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.repository.runExtractionTransaction(fn);
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ReviewServiceError) return error;
    if (error instanceof ExtractionServiceError) return error;
    if (error instanceof ImportServiceError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) return new ProjectValidationError(message, error.issues, error);
    return new ReviewServiceError(message, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** True when `evidence` still resolves exactly against `section` in `document`. */
export function evidenceStillValid(
  document: SourceDocument,
  section: DocumentSection,
  evidence: DocumentEvidence,
): boolean {
  if (evidence.start < 0 || evidence.end > section.text.length || evidence.end < evidence.start) return false;
  // The section must still be a faithful slice of the raw text.
  if (document.rawText.slice(section.start, section.end) !== section.text) return false;
  const slice = section.text.slice(evidence.start, evidence.end);
  if (evidence.quote !== undefined && evidence.quote !== slice) return false;
  const rawSlice = document.rawText.slice(section.start + evidence.start, section.start + evidence.end);
  return rawSlice === slice;
}

/** Dedupes evidence by (documentId, sectionId, start, end), preserving order. */
export function dedupeEvidence(list: DocumentEvidence[]): DocumentEvidence[] {
  const seen = new Set<string>();
  const out: DocumentEvidence[] = [];
  for (const ev of list) {
    const key = `${ev.documentId}|${ev.sectionId}|${ev.start}|${ev.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}
