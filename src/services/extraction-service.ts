import { ZodError, z } from 'zod';
import { now } from '@/utils/date';
import { createExtractionRecordId } from '@/utils/id';
import type { AiMessage } from '@/types';
import type { DocumentEvidence, DocumentSection, SourceDocument } from '@/types';
import type { ExtractionKind, ExtractionRecord } from '@/types';
import {
  ExtractionRecordSchema,
  buildDedupeKey,
  MAX_EXTRACTION_BODY_CHARS,
} from '@/schemas/extraction';
import { evidenceQuoteMatches } from '@/schemas/document';
import { ImportRepository } from '@/repositories/import-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ImportService, ImportServiceError, ImportNotFoundError } from './import-service';
import { ProjectServiceError } from './project-service';
import { resolveEvidenceInDocument } from '@/utils/evidence-resolution';
import type { GenerateOptions, ResolvedAiTarget } from './ai-service';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Base class for extraction-pipeline business errors. */
export class ExtractionServiceError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ExtractionServiceError';
  }
}

/** The extraction record was not found within the requested project. */
export class ExtractionNotFoundError extends ExtractionServiceError {
  constructor(id: string) {
    super(`Extraction "${id}" was not found`);
    this.name = 'ExtractionNotFoundError';
  }
}

/**
 * A validation/consistency rule blocked the operation. Carries a machine-
 * readable `reason` so callers and tests can assert on the specific failure
 * without string-matching messages.
 */
export class ExtractionValidationError extends ExtractionServiceError {
  readonly reason:
    | 'unconfirmed-structure'
    | 'empty-evidence'
    | 'invalid-evidence'
    | 'cross-document'
    | 'cross-project'
    | 'fabricated-quote'
    | 'ambiguous-quote'
    | 'out-of-bounds'
    | 'invalid-fields'
    | 'invalid-ai-output';

  constructor(reason: ExtractionValidationError['reason'], message: string) {
    super(message);
    this.name = 'ExtractionValidationError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Public input/output shapes                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A caller-supplied evidence hint. Offsets are OPTIONAL: when omitted they are
 * resolved from `quote` inside `sectionId`; when supplied they must reproduce
 * the quote (else the write is rejected).
 */
export interface EvidenceInput {
  sectionId: string;
  /** The exact verbatim quote as it appears in the section text. */
  quote: string;
  /**
   * Optional SECTION-relative start offset. Used to disambiguate repeated
   * quotes; validated against the quote otherwise. `start` and `end` must be
   * supplied together (or both omitted).
   */
  start?: number;
  end?: number;
}

/** Fields a caller sets when creating a MANUAL extraction candidate. */
export interface CreateManualExtractionInput {
  documentId: string;
  kind: ExtractionKind;
  title: string;
  summary?: string;
  body?: string;
  tags?: string[];
  /** At least one evidence hint, resolved against confirmed sections. */
  evidence: EvidenceInput[];
  relatedIds?: string[];
}

/** Fields a caller may change when editing an extraction (pre-review). */
export interface UpdateExtractionInput {
  kind?: ExtractionKind;
  title?: string;
  summary?: string;
  body?: string;
  tags?: string[];
  /** When provided, REPLACES the evidence set (re-resolved & re-validated). */
  evidence?: EvidenceInput[];
  relatedIds?: string[];
}

/** Options for an AI extraction run. */
export interface GenerateAiExtractionsInput {
  documentId: string;
  /** Kinds to ask the model for. Defaults to a sensible broad set. */
  kinds?: ExtractionKind[];
  /** Explicit model id; required so the caller is deliberate about the model. */
  modelId: string;
  /** Optional free-form focus (e.g. "characters only from chapter 2"). */
  instruction?: string;
  /** Cap on how many sections to send (and thus ask the model about). */
  maxSections?: number;
  /** Caller cancellation. */
  signal?: AbortSignal;
}

/** A single AI-produced candidate, before resolution/persistence. */
export interface AiExtractionCandidate {
  kind: ExtractionKind;
  title: string;
  summary?: string;
  body?: string;
  tags?: string[];
  confidence?: number | null;
  /**
   * Evidence as the model reported it: a section id + a verbatim quote, plus an
   * optional hint character offset within the section for disambiguation.
   */
  evidence: Array<{ sectionId: string; quote: string; hintStart?: number }>;
}

/** Result of `generateAiExtractions`. */
export interface GenerateAiExtractionsResult {
  /** Records that were created (persisted, pending review). */
  created: ExtractionRecord[];
  /** Records that were updated in place due to a dedupe-key collision. */
  updated: ExtractionRecord[];
  /** Candidates rejected because evidence could not be resolved/validated. */
  rejected: number;
  /** Model target that produced the candidates (for display/audit). */
  target: { providerName: string; modelName: string; modelId: string };
}

/** A generator matching `AiService.generate`'s signature (injectable for tests). */
export type GenerateFn = (options: GenerateOptions) => Promise<{
  result: { content: string; usage?: unknown; finishReason?: string };
  target: ResolvedAiTarget;
}>;

/* -------------------------------------------------------------------------- */
/* AI output schema (Zod) — validated before anything is persisted            */
/* -------------------------------------------------------------------------- */

const KINDS_FOR_AI = new Set<string>([
  'character', 'location', 'faction', 'item', 'concept', 'event', 'rule', 'relationship', 'style',
]);

const AiEvidenceSchema = z
  .object({
    sectionId: z.string().min(1),
    quote: z.string().min(1),
    hintStart: z.number().int().nonnegative().optional(),
  })
  .strict();

const AiCandidateSchema = z
  .object({
    kind: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    summary: z.string().max(1_000).optional().default(''),
    body: z.string().max(MAX_EXTRACTION_BODY_CHARS).optional().default(''),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).optional().default([]),
    confidence: z.number().min(0).max(1).nullable().optional(),
    evidence: z.array(AiEvidenceSchema).min(1).max(50),
  })
  .strict();

const AiResponseSchema = z
  .object({
    candidates: z.array(AiCandidateSchema).max(200),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* ExtractionService                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Business layer for information extraction (P8 Batch 3).
 *
 * Turns confirmed document structure into review-pending `ExtractionRecord`s,
 * either manually (caller-supplied) or via the existing P5 AI pipeline. Every
 * write is:
 *   - project-scoped (no cross-project reads/writes),
 *   - Zod-validated against `ExtractionRecordSchema`,
 *   - grounded in the stored raw text (each evidence resolves to an exact
 *     `rawText` slice),
 *   - created `pending` (manual AND ai — never bypassing the future review),
 *   - deduplicated transactionally by a deterministic key.
 *
 * This service NEVER writes to KnowledgeEntry / Character / World / Chapter /
 * Scene (or any project entity) — it only records candidates + their evidence.
 * Integration is a separate, later, user-reviewed concern.
 */
export class ExtractionService {
  private readonly repository: ImportRepository;
  private readonly importService: ImportService;
  private readonly generate: GenerateFn;
  /** Per-(project+dedupeKey) write locks — see the transactional upsert below. */
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(deps: {
    repository?: ImportRepository;
    importService?: ImportService;
    /** Injected AI executor; defaults to the P5 `AiService.generate`. */
    generate?: GenerateFn;
  } = {}) {
    this.repository = deps.repository ?? new ImportRepository();
    this.importService = deps.importService ?? new ImportService({ repository: this.repository });
    this.generate = deps.generate ?? defaultGenerate;
  }

  /* ------------------------------- Reads --------------------------------- */

  /** One extraction, scoped to `projectId` (null when absent/foreign). */
  async getExtraction(projectId: string, id: string): Promise<ExtractionRecord | null> {
    try {
      const record = await this.repository.getExtractionById(id);
      if (!record || record.projectId !== projectId) return null;
      return record;
    } catch (error) {
      throw this.wrap(error, `Failed to load extraction "${id}"`);
    }
  }

  /** All extractions of a project. */
  async listExtractions(projectId: string): Promise<ExtractionRecord[]> {
    try {
      return await this.repository.listExtractionsByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list extractions of project "${projectId}"`);
    }
  }

  /** Only the records still awaiting review, newest first. */
  async listPendingExtractions(projectId: string): Promise<ExtractionRecord[]> {
    const all = await this.listExtractions(projectId);
    return all.filter((record) => record.reviewStatus === 'pending');
  }

  /** All extractions for one document, scoped to `projectId`. */
  async listExtractionsByDocument(projectId: string, documentId: string): Promise<ExtractionRecord[]> {
    const document = await this.importService.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    try {
      const rows = await this.repository.listExtractionsByDocument(documentId);
      return rows.filter((record) => record.projectId === projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list extractions of document "${documentId}"`);
    }
  }

  /* --------------------------- Manual extraction ------------------------- */

  /**
   * Creates a REVIEW-PENDING manual extraction candidate.
   *
   * Steps:
   *   1. Resolve + verify the document exists in the project.
   *   2. Load its CONFIRMED sections (throws if structure is unconfirmed).
   *   3. Normalise + validate the candidate fields (via the record schema).
   *   4. Resolve every evidence quote against the confirmed section text and the
   *      stored raw text — rejecting fabricated/ambiguous/cross-section quotes.
   *   5. Upsert transactionally by dedupe key (never duplicates).
   *
   * The record is always `origin: 'manual'`, `reviewStatus: 'pending'` — a manual
   * candidate does NOT bypass the review flow, and `confidence` is never set here
   * (it is not a substitute for review).
   */
  async createManualExtraction(
    projectId: string,
    input: CreateManualExtractionInput,
  ): Promise<ExtractionRecord> {
    const document = await this.requireDocument(projectId, input.documentId);
    const sections = await this.loadConfirmedSections(projectId, document);
    const sectionById = new Map(sections.map((s) => [s.id, s]));

    const evidence = this.resolveEvidenceSet(document, sectionById, input.evidence, { projectId });

    const primarySectionId = evidence[0].sectionId;
    const timestamp = now();
    const record: ExtractionRecord = {
      id: createExtractionRecordId(),
      projectId,
      documentId: document.id,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? '',
      body: input.body ?? '',
      tags: input.tags ?? [],
      origin: 'manual',
      confidence: null,
      evidence,
      dedupeKey: buildDedupeKey({ documentId: document.id, kind: input.kind, title: input.title, primarySectionId }),
      reviewStatus: 'pending',
      relatedIds: input.relatedIds ?? [],
      integration: { status: 'not-applied' },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.validateRecord(record);

    return this.upsertByDedupeKey(projectId, record, { preserveReview: true });
  }

  /* ----------------------------- AI extraction --------------------------- */

  /**
   * Requests candidate extractions from the configured AI model and persists the
   * GROUNDED ones as review-pending records.
   *
   * Reuses the P5 execution path: the injected `generate` (defaults to
   * `AiService.generate`) is called with an explicit `modelId` and a custom
   * extraction prompt (carried on the existing `general-chat` task kind — no new
   * P5/P6 contract is introduced). The model is instructed to return JSON only;
   * its output is parsed and validated with Zod BEFORE anything is written.
   *
   * Every candidate's evidence quotes are resolved against the ACTUAL confirmed
   * section text — unsupported/ambiguous quotes are REJECTED (not fabricated).
   * Everything persisted is `origin: 'ai'`, `reviewStatus: 'pending'`, and
   * nothing is written to any project entity.
   */
  async generateAiExtractions(
    projectId: string,
    input: GenerateAiExtractionsInput,
  ): Promise<GenerateAiExtractionsResult> {
    const document = await this.requireDocument(projectId, input.documentId);
    const sections = await this.loadConfirmedSections(projectId, document);
    if (sections.length === 0) {
      throw new ExtractionValidationError('unconfirmed-structure', `Document "${document.id}" has no confirmed sections.`);
    }

    const kinds = (input.kinds && input.kinds.length > 0 ? input.kinds : DEFAULT_AI_KINDS).filter(isExtractionKind);
    const maxSections = Math.max(1, Math.min(input.maxSections ?? sections.length, sections.length));
    const sendSections = pickSectionsForAi(sections, maxSections);
    const sectionById = new Map(sendSections.map((s) => [s.id, s]));

    const messages = buildExtractionMessages(document, sendSections, kinds, input.instruction);

    let generated: Awaited<ReturnType<GenerateFn>>;
    try {
      generated = await this.generate({
        task: 'general-chat',
        messages,
        modelId: input.modelId,
        temperature: 0,
        signal: input.signal,
      });
    } catch (error) {
      throw this.wrap(error, `AI extraction failed for document "${document.id}"`);
    }

    const candidates = parseAiCandidates(generated.result.content, sectionById);

    const created: ExtractionRecord[] = [];
    const updated: ExtractionRecord[] = [];
    let rejected = 0;

    for (const candidate of candidates) {
      let evidence: DocumentEvidence[];
      try {
        evidence = this.resolveAiEvidence(document, sectionById, candidate, projectId);
      } catch {
        rejected += 1;
        continue;
      }
      if (evidence.length === 0) {
        rejected += 1;
        continue;
      }

      const timestamp = now();
      const primarySectionId = evidence[0].sectionId;
      const record: ExtractionRecord = {
        id: createExtractionRecordId(),
        projectId,
        documentId: document.id,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary ?? '',
        body: candidate.body ?? '',
        tags: candidate.tags ?? [],
        origin: 'ai',
        // Confidence is ADVISORY metadata only; review gates integration.
        confidence: candidate.confidence ?? null,
        evidence,
        dedupeKey: buildDedupeKey({
          documentId: document.id,
          kind: candidate.kind,
          title: candidate.title,
          primarySectionId,
        }),
        reviewStatus: 'pending',
        relatedIds: [],
        integration: { status: 'not-applied' },
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      try {
        this.validateRecord(record);
      } catch {
        rejected += 1;
        continue;
      }

      // Determine create-vs-update BEFORE the upsert so the caller can report it.
      const existedBefore = (await this.repository.findExtractionByDedupeKey(projectId, record.dedupeKey)) !== null;
      const outcome = await this.upsertByDedupeKey(projectId, record, { preserveReview: true });
      if (existedBefore) updated.push(outcome);
      else created.push(outcome);
    }

    return {
      created,
      updated,
      rejected,
      target: {
        providerName: String(generated.target.provider.name),
        modelName: String(generated.target.model.displayName),
        modelId: String(generated.target.model.modelId),
      },
    };
  }

  /* ------------------------------ Updates -------------------------------- */

  /**
   * Updates an extraction's editorial fields (and, optionally, replaces its
   * evidence set with a freshly-resolved one). Never changes `origin`,
   * `createdAt`, or the review status — review is handled elsewhere.
   */
  async updateExtraction(
    projectId: string,
    id: string,
    input: UpdateExtractionInput,
  ): Promise<ExtractionRecord> {
    const existing = await this.requireExtraction(projectId, id);
    const document = await this.requireDocument(projectId, existing.documentId);

    let evidence = existing.evidence;
    if (input.evidence !== undefined) {
      const sections = await this.loadConfirmedSections(projectId, document);
      const sectionById = new Map(sections.map((s) => [s.id, s]));
      evidence = this.resolveEvidenceSet(document, sectionById, input.evidence, { projectId });
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
      relatedIds: input.relatedIds ?? existing.relatedIds,
      evidence,
      dedupeKey: buildDedupeKey({
        documentId: existing.documentId,
        kind: nextKind,
        title: nextTitle,
        primarySectionId,
      }),
      updatedAt: now(),
    };
    this.validateRecord(merged);

    try {
      return await this.repository.updateExtraction(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update extraction "${id}"`);
    }
  }

    /* --------------------- Evidence (review-center probe) ------------------ */

  /**
   * Re-resolves a set of caller-supplied evidence hints against the CURRENT
   * confirmed structure of `document`, using the same validation rules as
   * manual/AI extraction (single source of truth: `resolveEvidenceSet`).
   *
   * Exposed for the P8 Batch-4 Extraction Review Center, whose edits may replace
   * a pending record's evidence. It NEVER writes anything; it only resolves and
   * validates, throwing `ExtractionValidationError` with a precise `reason` on
   * stale/fabricated/ambiguous/out-of-bounds input.
   */
  async resolveEvidenceForReview(
    projectId: string,
    document: SourceDocument,
    hints: EvidenceInput[],
  ): Promise<DocumentEvidence[]> {
    const sections = await this.loadConfirmedSections(projectId, document);
    const sectionById = new Map(sections.map((s) => [s.id, s]));
    return this.resolveEvidenceSet(document, sectionById, hints, { projectId });
  }

  /* ------------------------------ Deletion ------------------------------- */

  /**
   * Deletes an extraction. Does NOT touch the source document or its sections —
   * removing a candidate is independent of the structure it cited.
   */
  async deleteExtraction(projectId: string, id: string): Promise<void> {
    await this.requireExtraction(projectId, id);
    try {
      await this.repository.deleteExtraction(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete extraction "${id}"`);
    }
  }

  /* ------------------------------ Evidence ------------------------------- */

  /**
   * Resolves a list of caller evidence hints into validated `DocumentEvidence`.
   * Throws `ExtractionValidationError` with a precise reason on any failure.
   */
  private resolveEvidenceSet(
    document: SourceDocument,
    sectionById: Map<string, DocumentSection>,
    inputs: EvidenceInput[],
    ctx: { projectId: string },
  ): DocumentEvidence[] {
    if (!inputs || inputs.length === 0) {
      throw new ExtractionValidationError('empty-evidence', 'An extraction must cite at least one evidence location.');
    }

    const resolved: DocumentEvidence[] = [];
    const seen = new Set<string>();
    for (const hint of inputs) {
      const section = sectionById.get(hint.sectionId);
      if (!section) {
        // A section from another document in the same project, or one that is not
        // part of the confirmed set → reject as cross-document.
        throw new ExtractionValidationError(
          'cross-document',
          `Evidence section "${hint.sectionId}" is not a confirmed section of document "${document.id}".`,
        );
      }
      if (section.projectId !== ctx.projectId) {
        throw new ExtractionValidationError(
          'cross-project',
          `Evidence section "${hint.sectionId}" belongs to another project.`,
        );
      }

      let evidence: DocumentEvidence;
      if (hint.start !== undefined || hint.end !== undefined) {
        if (hint.start === undefined || hint.end === undefined) {
          throw new ExtractionValidationError('invalid-evidence', 'Evidence start and end must be supplied together.');
        }
        evidence = this.validateExplicitEvidence(document, section, {
          documentId: document.id,
          sectionId: section.id,
          start: hint.start,
          end: hint.end,
          quote: hint.quote,
        });
      } else {
        const result = resolveEvidenceInDocument(document.rawText, section, hint.quote);
        if (!result.ok) {
          throw new ExtractionValidationError(
            result.reason === 'ambiguous' ? 'ambiguous-quote' : result.reason === 'out-of-bounds' ? 'out-of-bounds' : 'fabricated-quote',
            result.detail,
          );
        }
        evidence = result.evidence;
      }

      const key = `${evidence.sectionId}:${evidence.start}:${evidence.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolved.push(evidence);
    }

    if (resolved.length === 0) {
      throw new ExtractionValidationError('empty-evidence', 'No valid evidence locations were supplied.');
    }
    return resolved;
  }

  /**
   * Validates EXPLICITLY-supplied offsets against the section text and raw text.
   * Rejects out-of-bounds ranges and any range whose slice is not exactly the
   * quote (fabricated/misaligned).
   */
  private validateExplicitEvidence(
    document: SourceDocument,
    section: DocumentSection,
    evidence: DocumentEvidence,
  ): DocumentEvidence {
    const { start, end, quote } = evidence;
    if (
      !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || end < start || end > section.text.length
    ) {
      throw new ExtractionValidationError('out-of-bounds', `Evidence range [${start}, ${end}) is outside section "${section.id}".`);
    }
    const slice = section.text.slice(start, end);
    if (slice !== quote) {
      throw new ExtractionValidationError(
        'fabricated-quote',
        `Evidence quote does not match the section text at [${start}, ${end}).`,
      );
    }
    if (!evidenceQuoteMatches(evidence, section.text)) {
      throw new ExtractionValidationError('fabricated-quote', 'Evidence quote does not match its addressed slice.');
    }
    // Final check against the RAW text (document-relative).
    const docStart = section.start + start;
    const docEnd = section.start + end;
    if (document.rawText.slice(docStart, docEnd) !== quote) {
      throw new ExtractionValidationError('fabricated-quote', 'Evidence does not match the original document text.');
    }
    return { ...evidence, documentId: document.id, sectionId: section.id };
  }

  /**
   * Resolves a model-provided candidate's evidence. Throws when any SINGLE quote
   * cannot be resolved (the whole candidate is rejected rather than persisted
   * with a missing locator). Returns a non-empty, deduped list on success.
   */
  private resolveAiEvidence(
    document: SourceDocument,
    sectionById: Map<string, DocumentSection>,
    candidate: AiExtractionCandidate,
    projectId: string,
  ): DocumentEvidence[] {
    const evidence: DocumentEvidence[] = [];
    const seen = new Set<string>();
    for (const hint of candidate.evidence) {
      const section = sectionById.get(hint.sectionId);
      if (!section || section.projectId !== projectId) {
        throw new ExtractionValidationError('cross-document', `AI cited unknown section "${hint.sectionId}".`);
      }
      const result = resolveEvidenceInDocument(document.rawText, section, hint.quote, {
        expectedStart: hint.hintStart,
      });
      if (!result.ok) {
        throw new ExtractionValidationError(
          result.reason === 'ambiguous' ? 'ambiguous-quote' : 'fabricated-quote',
          result.detail,
        );
      }
      const key = `${result.evidence.sectionId}:${result.evidence.start}:${result.evidence.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      evidence.push(result.evidence);
    }
    return evidence;
  }

  /* -------------------------- Transactional upsert ----------------------- */

    /**
   * Persists `desired` keyed by its dedupe key. If a record with the same key
   * already exists it is UPDATED in place (preserving its id/createdAt and, when
   * `preserveReview`, its review status), never duplicated.
   *
   * Concurrency — three independent layers, defence in depth:
   *   1. Schema: the v10 UNIQUE index `&[projectId+dedupeKey]` makes a duplicate
   *      INSERT impossible at the IndexedDB level, even across independent
   *      service instances or browser tabs.
   *   2. Transaction: the find→create/update sequence runs inside ONE Dexie
   *      readwrite transaction, so within a single connection it is atomic.
   *   3. Lock: an in-process per-key lock serialises same-key writes on one
   *      instance (keeps the common path a clean upsert and avoids churn).
   *
   * If layers 1–3 still race (e.g. two tabs each believe no row exists), the
   * losing `add()` throws a ConstraintError; we catch it and fall back to an
   * UPDATE of the now-existing row, so the observable result is always exactly
   * one record and the call still succeeds idempotently.
   */
  private upsertByDedupeKey(
    projectId: string,
    desired: ExtractionRecord,
    options: { preserveReview: boolean },
  ): Promise<ExtractionRecord> {
    const lockKey = `${projectId}::${desired.dedupeKey}`;
    return this.withWriteLock(lockKey, () =>
      this.repository.runExtractionTransaction(async () => {
        const existing = await this.repository.findExtractionByDedupeKey(projectId, desired.dedupeKey);
        if (!existing) {
          try {
            return await this.repository.createExtraction(desired);
          } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;
            // A concurrent writer won the insert race between our find and add.
            // Re-read and update that row instead of failing.
            const raced = await this.repository.findExtractionByDedupeKey(projectId, desired.dedupeKey);
            if (!raced) throw error;
            return this.updateMerged(raced, desired, options);
          }
        }
        return this.updateMerged(existing, desired, options);
      }),
    );
  }

  /** Merges `desired` onto an existing row, preserving immutable/review fields. */
  private updateMerged(
    existing: ExtractionRecord,
    desired: ExtractionRecord,
    options: { preserveReview: boolean },
  ): Promise<ExtractionRecord> {
    const merged: ExtractionRecord = {
      ...desired,
      id: existing.id,
      createdAt: existing.createdAt,
      reviewStatus: options.preserveReview ? existing.reviewStatus : desired.reviewStatus,
      integration: existing.integration,
      updatedAt: now(),
    };
    this.validateRecord(merged);
    return this.repository.updateExtraction(merged);
  }

  /** Serialises writes per lock key (see `upsertByDedupeKey`). */
  private withWriteLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const run = previous.then(() => op(), () => op());
    const tail = run.then(() => undefined, () => undefined);
    this.writeLocks.set(key, tail);
    void tail.then(() => {
      if (this.writeLocks.get(key) === tail) this.writeLocks.delete(key);
    });
    return run;
  }

  /* ------------------------------- helpers ------------------------------- */

  private async requireDocument(projectId: string, documentId: string): Promise<SourceDocument> {
    const document = await this.importService.getDocument(projectId, documentId);
    if (!document) throw new ImportNotFoundError(`Document "${documentId}"`);
    return document;
  }

  /**
   * Loads the document's CONFIRMED sections. Throws `unconfirmed-structure` when
   * the structure is not confirmed — extraction may only use confirmed input.
   */
  private async loadConfirmedSections(projectId: string, document: SourceDocument): Promise<DocumentSection[]> {
    if (document.structureConfirmedAt == null) {
      throw new ExtractionValidationError(
        'unconfirmed-structure',
        `Document "${document.id}" structure is not confirmed; confirm it before extracting.`,
      );
    }
    try {
      return await this.importService.getConfirmedSections(projectId, document.id);
    } catch (error) {
      if (error instanceof ImportServiceError) {
        throw new ExtractionValidationError('unconfirmed-structure', error.message);
      }
      throw error;
    }
  }

  private async requireExtraction(projectId: string, id: string): Promise<ExtractionRecord> {
    const record = await this.getExtraction(projectId, id);
    if (!record) throw new ExtractionNotFoundError(id);
    return record;
  }

  private validateRecord(record: ExtractionRecord): void {
    const result = ExtractionRecordSchema.safeParse(record);
    if (!result.success) {
      throw new ExtractionValidationError(
        'invalid-fields',
        `Extraction is invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ExtractionServiceError) return error;
    if (error instanceof ImportServiceError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) return new ProjectValidationError(message, error.issues, error);
    return new ExtractionServiceError(message, error);
  }
}

/* -------------------------------------------------------------------------- */
/* AI prompt + parsing helpers (pure, unit-testable)                          */
/* -------------------------------------------------------------------------- */

/** Default kinds asked of the model when the caller does not narrow them. */
const DEFAULT_AI_KINDS: ExtractionKind[] = [
  'character', 'location', 'faction', 'item', 'concept', 'event', 'rule', 'relationship',
];

/**
 * Detects an IndexedDB/Dexie UNIQUE-index violation anywhere in an error's
 * `cause` chain (the repository wraps the raw Dexie error as `cause`). Used to
 * turn a rare concurrent-insert race on the `&[projectId+dedupeKey]` unique
 * index into a clean update instead of a surfaced failure.
 */
function isUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    const candidate = current as { name?: unknown; message?: unknown; inner?: unknown; cause?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    if (name === 'ConstraintError' || /Key already exists/i.test(message) || /constraint/i.test(name)) {
      return true;
    }
    current = candidate.inner ?? candidate.cause;
  }
  return false;
}

/** A hard cap on how much text we send in one AI extraction request. */
const MAX_AI_PROMPT_CHARS = 24_000;

function isExtractionKind(value: string): value is ExtractionKind {
  return KINDS_FOR_AI.has(value);
}

/**
 * Picks the sections to send to the model, in document order, stopping before
 * the prompt grows too large. Falls back to the first `maxSections` when even a
 * single section would exceed the budget.
 */
function pickSectionsForAi(sections: DocumentSection[], maxSections: number): DocumentSection[] {
  const ordered = [...sections].sort((a, b) => a.order - b.order);
  const picked: DocumentSection[] = [];
  let budget = MAX_AI_PROMPT_CHARS;
  for (const section of ordered) {
    if (picked.length >= maxSections) break;
    const cost = section.text.length + 40; // rough per-section overhead
    if (cost > budget && picked.length > 0) break;
    budget -= cost;
    picked.push(section);
  }
  return picked.length > 0 ? picked : ordered.slice(0, maxSections);
}

/**
 * Builds the system + user messages instructing the model to extract ONLY
 * information supported by the supplied text and to return strict JSON whose
 * evidence quotes are verbatim substrings of the given sections.
 */
export function buildExtractionMessages(
  document: SourceDocument,
  sections: DocumentSection[],
  kinds: ExtractionKind[],
  instruction?: string,
): AiMessage[] {
  const system =
    'You are a precise information-extraction engine for a novel manuscript. ' +
    'Extract ONLY information that is DIRECTLY SUPPORTED by the supplied document text. ' +
    'Never invent facts, never infer beyond the text, and never fabricate quotes. ' +
    'For every candidate you MUST cite at least one piece of evidence: the exact id of a supplied section ' +
    'and a VERBATIM quote copied character-for-character from that section. ' +
    'If you cannot quote supporting text, do not emit the candidate. ' +
    'Return ONLY a JSON object of the form {"candidates":[{...}]} with no prose or markdown fences.';

  const allowed = kinds.join(', ');
  const sectionBlocks = sections
    .map(
      (s) =>
        `SECTION id="${s.id}" level="${s.level}" title=${JSON.stringify(s.title)}\n` +
        '"""\n' + s.text + '\n"""',
    )
    .join('\n\n');

  const user = [
    `Document: ${document.fileName ?? document.id}`,
    `Extract candidates of these kinds ONLY: ${allowed}.`,
    instruction ? `Additional focus: ${instruction}` : '',
    '',
    'Each candidate object must have EXACTLY these fields:',
    '  {"kind": string (one of the allowed kinds), "title": string, "summary": string, ' +
      '"body": string, "tags": string[], "confidence": number (0..1), ' +
      '"evidence": [{"sectionId": string, "quote": string, "hintStart"?: number}]}',
    '',
    'DOCUMENT SECTIONS (cite sectionId + an exact quote from that section):',
    sectionBlocks,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Parses the model's raw response into validated candidates.
 *
 * Tolerates a wrapping ```json fence (models add them despite instructions) but
 * otherwise requires strict, Zod-valid JSON of the documented shape. Throws
 * `ExtractionValidationError('invalid-ai-output')` on anything malformed — we
 * never persist a partially-understood response.
 */
export function parseAiCandidates(content: string, sectionById: Map<string, DocumentSection>): AiExtractionCandidate[] {
  const json = stripJsonFence(content);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ExtractionValidationError('invalid-ai-output', `AI response was not valid JSON: ${(error as Error).message}`);
  }

  const parsed = AiResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExtractionValidationError(
      'invalid-ai-output',
      `AI response did not match the expected schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }

  const candidates: AiExtractionCandidate[] = [];
  for (const candidate of parsed.data.candidates) {
    if (!isExtractionKind(candidate.kind)) {
      // Unknown kind → drop (never coerce to a guessed type).
      continue;
    }
    // Keep only evidence that names a section we actually sent — others cannot
    // be resolved and would be fabricated locations.
    const evidence = candidate.evidence
      .filter((ev) => sectionById.has(ev.sectionId))
      .map((ev) => ({ sectionId: ev.sectionId, quote: ev.quote, hintStart: ev.hintStart }));
    if (evidence.length === 0) continue;
    candidates.push({
      kind: candidate.kind as ExtractionKind,
      title: candidate.title,
      summary: candidate.summary,
      body: candidate.body,
      tags: candidate.tags,
      confidence: candidate.confidence ?? null,
      evidence,
    });
  }
  return candidates;
}

/** Strips a single wrapping ```json ... ``` fence, if present. */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Default AI executor: delegates to the P5 `AiService.generate` singleton.
 *
 * Imported lazily inside the function so merely importing this module never
 * eagerly constructs the AI services (which matters in Node unit tests that
 * inject their own generator and never touch the network). Rollup emits a
 * benign `INEFFECTIVE_DYNAMIC_IMPORT` notice because `AiService` is also
 * statically imported by other P5/P6 services; the lazy boundary is intentional
 * and the shared singleton is the canonical generation entry point.
 */
async function defaultGenerate(options: GenerateOptions): Promise<{
  result: { content: string; usage?: unknown; finishReason?: string };
  target: ResolvedAiTarget;
}> {
  const { aiService } = await import('./index');
  const { result, target } = await aiService.generate(options);
  return { result, target };
}