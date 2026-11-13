import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createCharacterId, createKnowledgeEntryId, createWorldId, createWorldSectionId } from '@/utils/id';
import { hashRawText } from '@/utils/text-hash';
import type {
  Character,
  DocumentSection,
  ExtractionRecord,
  KnowledgeEntry,
  KnowledgeEntryKind,
  SourceDocument,
  World,
} from '@/types';
import type { ConflictResolution, ConflictStrategy } from '@/schemas/extraction';
import { ExtractionRecordSchema } from '@/schemas/extraction';
import { buildSourceKey, deriveSearchText } from '@/schemas/knowledge';
import { ImportRepository } from '@/repositories/import-repository';
import { KnowledgeRepository } from '@/repositories/knowledge-repository';
import { CharacterRepository } from '@/repositories/character-repository';
import { WorldRepository } from '@/repositories/world-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ImportService } from './import-service';
import { evidenceStillValid } from './review-service';
import { ProjectServiceError } from './project-service';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Base class for Project Integration business errors. */
export class IntegrationServiceError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'IntegrationServiceError';
  }
}

/** The extraction record was not found within the requested project. */
export class IntegrationNotFoundError extends IntegrationServiceError {
  constructor(id: string) {
    super(`Extraction "${id}" was not found in this project`);
    this.name = 'IntegrationNotFoundError';
  }
}

/**
 * A lifecycle/consistency rule blocked the integration. Carries a machine-
 * readable `reason` so callers/tests can assert on the specific failure.
 *
 * Reasons:
 *   - `not-confirmed`     -- only `confirmed` records may be integrated.
 *   - `cross-project`     -- a referenced entity belongs to another project.
 *   - `invalid-evidence`  -- the record has no evidence that still resolves.
 *   - `invalid-fields`    -- Zod validation of a written entity failed.
 *   - `already-applied`   -- the record was already integrated (apply is one-shot).
 *   - `wrong-target`      -- an apply carries a different target type to routing.
 *   - `missing-preview`   -- an apply without a preview fingerprint.
 *   - `stale-preview`     -- the preview no longer reflects the current state;
 *                           the user must regenerate it before applying.
 *   - `unsupported-field` -- a `use-extracted` decision targets a field the
 *                           current model cannot update safely.
 */
export class IntegrationValidationError extends IntegrationServiceError {
  readonly reason:
    | 'not-confirmed'
    | 'cross-project'
    | 'invalid-evidence'
    | 'invalid-fields'
    | 'already-applied'
    | 'wrong-target'
    | 'missing-preview'
    | 'stale-preview'
    | 'unsupported-field';

  constructor(reason: IntegrationValidationError['reason'], message: string) {
    super(message);
    this.name = 'IntegrationValidationError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Public input/output shapes                                                 */
/* -------------------------------------------------------------------------- */

/** The concrete entity types integration can write. */
export type IntegrationTargetType = 'character' | 'world-section' | 'knowledge-entry';

/** One record and the outcome of integrating it. */
export interface IntegrationItemResult {
  extractionId: string;
  /** The record AFTER integration (its `integration` metadata is `applied`). */
  record: ExtractionRecord;
  /** The concrete entity that now carries the information. */
  target: {
    type: IntegrationTargetType;
    id: string;
  };
  /** `created` a new entity, or matched and refreshed an existing one. */
  applied: 'created' | 'updated';
  /**
   * Fields where the existing entity DIFFERS from the incoming record. On a
   * preview these are proposals; on an apply they are the conflicts that were
   * resolved (outcome in `resolutions`).
   */
  conflicts: Array<{ field: string; existing: string; incoming: string }>;
  /** How each conflict field was resolved (empty on a preview / no conflicts). */
  resolutions: ConflictResolution[];
  /** The preview fingerprint the user confirmed (empty on a preview). */
  confirmedFingerprint: string;
}

/** Result of integrating one or more confirmed records. */
export interface IntegrationBatchResult {
  /** How many records were integrated. */
  integrated: number;
  /** How many were skipped (not-confirmed / already applied / not found). */
  skipped: number;
  items: IntegrationItemResult[];
  /** The updated extraction rows, in processing order. */
  records: ExtractionRecord[];
  /** Records that failed with their reason (never silently swallowed). */
  failures: Array<{ extractionId: string; reason: string; message: string }>;
}

/* -------------------------------------------------------------------------- */
/* Preview shapes                                                             */
/* -------------------------------------------------------------------------- */

/** One field the entity will receive, and how it maps onto the model. */
export interface PreviewFieldMapping {
  /** Logical field name (also the field-strategy key). */
  field: string;
  /** The value the extraction proposes. */
  incoming: string;
  /** The value the entity holds TODAY (`''` when the entity is new). */
  existing: string;
  /** True when the model supports writing this field automatically. */
  supported: boolean;
  /** True when existing and incoming differ (a conflict the user must decide). */
  conflict: boolean;
  /** The strategy a field defaults to if the user makes no explicit choice. */
  defaultStrategy: ConflictStrategy;
}

/** A target entity that already matches the incoming record. */
export interface PreviewExistingMatch {
  id: string;
  /** The entity's current display label (name/section title/entry title). */
  label: string;
}

/** Who the record will be routed to, and what is expected to happen. */
export interface PreviewPlan {
  targetType: IntegrationTargetType;
  /** `create` (no match) or `update` (an existing entity was matched). */
  expectedAction: 'create' | 'update';
  /** The matched entity, when `expectedAction === 'update'`. */
  existingMatch: PreviewExistingMatch | null;
  /** Field-level mapping + conflicts. */
  fields: PreviewFieldMapping[];
  /** Fields where a `use-extracted` decision is NOT supported by the model. */
  unsupportedFields: string[];
  /** The number of conflicts the user must resolve. */
  conflictCount: number;
}

/** One evidence locator with its live validity. */
export interface PreviewEvidence {
  documentId: string;
  sectionId: string;
  start: number;
  end: number;
  quote: string;
  sectionTitle: string | null;
  /** The exact text the locator addresses in the CURRENT section, if resolvable. */
  slice: string | null;
  valid: boolean;
  problem?: string;
}

/**
 * A READ-ONLY integration preview for one record.
 *
 * Contains everything the user needs to decide: the record + its review status,
 * source document/sections, per-evidence validity, the routing plan with field
 * mappings/conflicts and the existing match, whether it is already integrated,
 * and a deterministic FINGERPRINT. `applyIntegration` re-derives all of this
 * inside its transaction and refuses when the fingerprint no longer matches.
 */
export interface IntegrationPreview {
  extractionId: string;
  projectId: string;
  record: ExtractionRecord;
  reviewStatus: ExtractionRecord['reviewStatus'];
  document: SourceDocument | null;
  evidence: PreviewEvidence[];
  evidenceValid: boolean;
  plan: PreviewPlan;
  /** True when the record was ALREADY integrated (apply would be a no-op). */
  alreadyIntegrated: boolean;
  /** Deterministic content/state fingerprint of the previewed state. */
  fingerprint: string;
  generatedAt: number;
}

/** User confirmation required to apply a preview. */
export interface ApplyIntegrationInput {
  /** The fingerprint returned by `previewIntegration`; must still be current. */
  previewFingerprint: string;
  /**
   * Optional explicit target to apply to. When supplied it MUST equal the
   * routed target; this guards against applying to a different entity.
   */
  targetId?: string;
  /** Per-field strategy choices (field name -- strategy). */
  fieldStrategies?: Record<string, ConflictStrategy>;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Kinds that map onto a dedicated `Character` entity. */
const CHARACTER_KINDS = new Set(['character']);
/** Kinds that map onto a `World` section (setting / world building). */
const WORLD_KINDS = new Set(['location', 'faction', 'rule']);

/**
 * Character fields that the integration model must NOT update from an
 * extraction: `role`/`status` are never expressed by an extraction and `status`
 * has continuity implications (a character marked `deceased` must not be
 * flipped by a re-import). A `use-extracted` decision on them is refused
 * (`unsupported-field`) rather than guessed.
 */
const CHARACTER_UNSUPPORTED_FIELDS = new Set([
  'personality',
  'motivation',
  'appearance',
  'role',
  'status',
  'name',
]);

/** The knowledge-entry kind a record is indexed as (relationship/style -- concept). */
function knowledgeKindFor(kind: ExtractionRecord['kind']): KnowledgeEntryKind {
  if (kind === 'relationship' || kind === 'style') return 'concept';
  return kind as KnowledgeEntryKind;
}

/** The target type a record routes to (pure; no I/O). */
function targetTypeFor(kind: ExtractionRecord['kind']): IntegrationTargetType {
  if (CHARACTER_KINDS.has(kind)) return 'character';
  if (WORLD_KINDS.has(kind)) return 'world-section';
  return 'knowledge-entry';
}

/** First non-empty line, trimmed (for a list summary). */
function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > 500 ? line.slice(0, 500) : line;
}

/** Truncates a title to the schema maximum (200 chars). */
function clampTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

/** Truncates a world-section title to the schema maximum (80 chars). */
function clampSectionTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed;
}

/** Normalises a value for conflict comparison (trim + lower-case). */
function sameValue(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Deterministic knowledge source key for an integrated extraction, so a re-run
 * matches (and refreshes) the entry an earlier run created instead of duplicating.
 */
function knowledgeSourceKeyFor(kind: ExtractionRecord['kind'], extractionId: string): string {
  return buildSourceKey('manual', extractionId, `integration:${kind}`) ?? `extraction:${kind}:${extractionId}`;
}

/** The content of a world section built from a record. */
function worldSectionContent(record: ExtractionRecord): string {
  return [record.summary, record.body].filter(Boolean).join('\n\n');
}

/** The title/summary a record produces for a knowledge entry. */
function knowledgeFields(record: ExtractionRecord): { title: string; summary: string } {
  return { title: clampTitle(record.title), summary: record.summary || firstLine(record.body) };
}

/**
 * The field MAPPINGS integration proposes for a record, given CURRENT values of
 * the matched entity (`''`/`[]` for a new entity). This is the SINGLE source of
 * truth shared by preview and apply, so a preview can never describe a
 * different write than the one apply performs.
 */
function planFieldMappings(
  targetType: IntegrationTargetType,
  record: ExtractionRecord,
  existing: ExistingTargetFields,
): PreviewFieldMapping[] {
  const mapping = (field: string, incoming: string, current: string): PreviewFieldMapping => ({
    field,
    incoming,
    existing: current,
    supported: true,
    conflict: incoming.trim() !== '' && !sameValue(incoming, current),
    defaultStrategy: 'keep-existing',
  });

  if (targetType === 'character') {
    return [
      mapping('summary', record.summary, existing.summary),
      mapping('background', record.body, existing.background),
      // Tags merge additively; a conflict is reported when an INCOMING tag is
      // not already present (so an all-known tag set is never a conflict).
      {
        field: 'tags',
        incoming: record.tags.join(', '),
        existing: existing.tags.join(', '),
        supported: true,
        conflict:
          record.tags.length > 0 && record.tags.some((t) => !existing.tags.some((e) => sameValue(e, t))),
        defaultStrategy: 'keep-existing',
      },
    ];
  }

  if (targetType === 'world-section') {
    return [mapping('content', worldSectionContent(record), existing.summary)];
  }

  const { summary } = knowledgeFields(record);
  return [mapping('summary', summary, existing.summary)];
}

/** Fields a `use-extracted` decision must NOT touch for the target type. */
function unsupportedFieldsFor(targetType: IntegrationTargetType): string[] {
  if (targetType === 'world-section') return ['title'];
  if (targetType === 'character') return [...CHARACTER_UNSUPPORTED_FIELDS];
  return [];
}

/** A stable ordering of a strategy record so fingerprints are order-independent. */
function stableStrategies(fieldStrategies: Record<string, ConflictStrategy> | undefined): Array<[string, string]> {
  if (!fieldStrategies) return [];
  return Object.keys(fieldStrategies)
    .sort()
    .map((k) => [k, fieldStrategies[k]]);
}

/**
 * Computes the deterministic fingerprint of a previewed state. Any change to
 * the record, its review status, the cited document text, the existing entity,
 * or the user's strategy choices changes this value -- which is exactly why a
 * stale preview can never be applied.
 */
function computeFingerprint(parts: {
  record: ExtractionRecord;
  reviewStatus: string;
  documentHash: string;
  targetType: IntegrationTargetType;
  existingId: string | null;
  existingSignature: string;
  fields: PreviewFieldMapping[];
  fieldStrategies?: Record<string, ConflictStrategy>;
}): string {
  const payload = JSON.stringify({
    id: parts.record.id,
    updatedAt: parts.record.updatedAt,
    reviewStatus: parts.reviewStatus,
    integration: parts.record.integration.status,
    kind: parts.record.kind,
    title: parts.record.title,
    summary: parts.record.summary,
    body: parts.record.body,
    tags: [...parts.record.tags].sort(),
    evidence: parts.record.evidence,
    documentHash: parts.documentHash,
    targetType: parts.targetType,
    existingId: parts.existingId,
    existingSignature: parts.existingSignature,
    fields: parts.fields.map((f) => [f.field, f.incoming, f.existing, f.conflict]),
    strategies: stableStrategies(parts.fieldStrategies),
  });
  return `prv_${hashRawText(payload)}`;
}

/**
 * Applies the user's field strategies to the proposed field mappings and
 * returns an auditable resolution record per field.
 *
 * `unsupportedFields` are refused for any `use-extracted` choice (the model
 * cannot write them). Fields without a chosen strategy fall back to
 * `defaultStrategy`: the interactive (apply) path passes `keep-existing` so no
 * silent overwrite is ever possible, while the legacy path passes
 * `fill-empty-only` to preserve its historical create/update semantics.
 */
function resolveFields(
  fields: PreviewFieldMapping[],
  fieldStrategies: Record<string, ConflictStrategy> | undefined,
  unsupportedFields: string[],
  defaultStrategy: ConflictStrategy,
): ConflictResolution[] {
  const resolutions: ConflictResolution[] = [];

  // Refuse `use-extracted` on any unsupported field FIRST — including fields that
  // are not part of the automatic plan (e.g. a Character's `role`/`status`).
  // Silently ignoring such a choice would let the caller believe a value was
  // written when it was not, so it is rejected (`unsupported-field`).
  if (fieldStrategies) {
    for (const [field, chosen] of Object.entries(fieldStrategies)) {
      if (chosen === 'use-extracted' && unsupportedFields.includes(field)) {
        throw new IntegrationValidationError(
          'unsupported-field',
          `Field "${field}" cannot be updated from an extraction; only keep-existing is safe here.`,
        );
      }
    }
  }

  for (const field of fields) {
    const chosen = fieldStrategies?.[field.field];
    const strategy: ConflictStrategy = chosen ?? defaultStrategy;

    if (chosen === 'use-extracted' && unsupportedFields.includes(field.field)) {
      throw new IntegrationValidationError(
        'unsupported-field',
        `Field "${field.field}" cannot be updated from an extraction; only keep-existing is safe here.`,
      );
    }

    let outcome: string;
    if (strategy === 'use-extracted') {
      outcome = field.incoming;
    } else {
      // `keep-existing` / `fill-empty-only` both preserve a CURRENT value when
      // one exists, and otherwise take the extraction's value. A brand-new target
      // (or an empty field) has nothing to "keep", so the reviewed data must
      // populate it rather than being silently discarded. They differ only in
      // intent: `keep-existing` never overwrites a populated field, and
      // `fill-empty-only` is the legacy default with the same effect.
      outcome = field.existing.trim() === '' ? field.incoming : field.existing;
    }
    const changed = !sameValue(outcome, field.existing);

    resolutions.push({
      field: field.field,
      strategy,
      existing: field.existing.slice(0, 4_000),
      incoming: field.incoming.slice(0, 4_000),
      outcome: outcome.slice(0, 4_000),
      changed,
    });
  }

  return resolutions;
}

/** Value of a resolution by field name (fields are unique). */
function resolutionValue(resolutions: ConflictResolution[], field: string, fallback: string): string {
  const found = resolutions.find((r) => r.field === field);
  return found ? found.outcome : fallback;
}

/** Parses a comma-separated tag resolution back into a tag list. */
function resolutionTags(resolutions: ConflictResolution[], fallback: string[]): string[] {
  const found = resolutions.find((r) => r.field === 'tags');
  if (!found) return fallback;
  return found.outcome
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Builds the per-evidence validity descriptor for a preview. */
function previewEvidence(
  document: SourceDocument,
  section: DocumentSection | null,
  ev: ExtractionRecord['evidence'][number],
): PreviewEvidence {
  const valid = section ? evidenceStillValid(document, section, ev) : false;
  let slice: string | null = null;
  if (section) {
    const fromRaw = document.rawText.slice(ev.start, ev.end);
    slice = fromRaw === (ev.quote ?? fromRaw) ? fromRaw : ev.quote || null;
  }
  return {
    documentId: ev.documentId,
    sectionId: ev.sectionId,
    start: ev.start,
    end: ev.end,
    quote: ev.quote ?? '',
    sectionTitle: section?.title ?? null,
    slice,
    valid,
    ...(valid ? {} : { problem: 'This locator no longer resolves against the current document.' }),
  };
}

/* -------------------------------------------------------------------------- */
/* Internal target shapes                                                     */
/* -------------------------------------------------------------------------- */

/** The values of an existing (or blank) target entity, used for planning. */
interface ExistingTargetFields {
  summary: string;
  background: string;
  tags: string[];
}

/** Everything needed to plan + write an integration target. */
interface ResolvedTarget {
  id: string | null;
  label: string;
  signature: string;
  fields: ExistingTargetFields;
  character: Character | null;
  world: World | null;
  sectionId: string | null;
  entry: KnowledgeEntry | null;
}

/** The outcome of writing an entity. */
interface WrittenEntity {
  id: string;
  created: boolean;
}

/* -------------------------------------------------------------------------- */
/* IntegrationService                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Business layer for Project Integration (P8 Batch 5).
 *
 * The ONLY phase that turns reviewed `ExtractionRecord`s into real project
 * entities. Preview and Apply are SEPARATE, and Apply is one-shot:
 *
 * ## Preview (read-only)
 *   `previewIntegration` returns the record, source document + per-evidence
 *   validity, the routing plan (target entity, existing match, field mappings,
 *   conflicts) and a deterministic FINGERPRINT. It writes nothing.
 *
 * ## Apply (explicit, transactional)
 *   `applyIntegration` requires the preview's fingerprint. Inside ONE Dexie
 *   transaction spanning the import tables + the target entity table it
 *   RE-READS the record, RE-CHECKS `confirmed`, RE-VALIDATES evidence,
 *   RE-RESOLVES the target + conflicts and RECOMPUTES the fingerprint. A
 *   mismatch (`stale-preview`) aborts with NO writes. Every step (entity write,
 *   audit trail, record stamp) commits or rolls back together. No network/AI
 *   call happens inside the transaction.
 *
 * ## Field-level conflicts
 *   A changed field is never silently overwritten. The user picks a per-field
 *   strategy (`keep-existing` default, `use-extracted`, `fill-empty-only`);
 *   `use-extracted` on a field the model cannot update safely is refused.
 *
 * ## Routing
 *   - `character`                    -- `Character` (matched by exact name)
 *   - `location` / `faction` / `rule` -- `World` section (matched by exact title)
 *   - everything else                -- `KnowledgeEntry` (matched by `sourceKey`)
 *
 * ## Back-compat
 *   `integrateExtraction` / `integrateMany` remain conservative entry points
 *   (default strategies: keep populated fields, fill empty ones) so existing
 *   callers/tests keep their guarantees.
 */
export class IntegrationService {
  private readonly repository: ImportRepository;
  private readonly knowledgeRepository: KnowledgeRepository;
  private readonly characterRepository: CharacterRepository;
  private readonly worldRepository: WorldRepository;
  private readonly importService: ImportService;

  constructor(deps: {
    repository?: ImportRepository;
    knowledgeRepository?: KnowledgeRepository;
    characterRepository?: CharacterRepository;
    worldRepository?: WorldRepository;
    importService?: ImportService;
  } = {}) {
    this.repository = deps.repository ?? new ImportRepository();
    this.knowledgeRepository = deps.knowledgeRepository ?? new KnowledgeRepository();
    this.characterRepository = deps.characterRepository ?? new CharacterRepository();
    this.worldRepository = deps.worldRepository ?? new WorldRepository();
    this.importService = deps.importService ?? new ImportService({ repository: this.repository });
  }

  /* -------------------------------- Reads -------------------------------- */

  /** Confirmed records of a project still awaiting integration (not yet applied). */
  async listPendingIntegration(projectId: string): Promise<ExtractionRecord[]> {
    const all = await this.listProjectExtractions(projectId);
    return all.filter(
      (record) => record.reviewStatus === 'confirmed' && record.integration.status !== 'applied',
    );
  }

  /** Every extraction record of a project (for glance inspection / diagnostics). */
  async listExtractions(projectId: string): Promise<ExtractionRecord[]> {
    return this.listProjectExtractions(projectId);
  }

  /* ------------------------------- Preview -------------------------------- */

  /**
   * Builds a READ-ONLY preview of what applying one record would do. Never
   * writes. When `fieldStrategies` are supplied they are folded into the
   * fingerprint, so an apply MUST pass the same choices.
   */
  async previewIntegration(
    projectId: string,
    extractionId: string,
    fieldStrategies?: Record<string, ConflictStrategy>,
  ): Promise<IntegrationPreview> {
    const record = await this.requireExtraction(projectId, extractionId);
    const document = await this.importService.getDocument(projectId, record.documentId);
    if (!document) {
      throw new IntegrationValidationError(
        'invalid-evidence',
        `Extraction "${record.id}" cites a document that no longer exists.`,
      );
    }
    const sections = await this.importService.getSections(projectId, record.documentId);
    const byId = new Map(sections.map((s) => [s.id, s]));
    const evidence = record.evidence.map((ev) => previewEvidence(document, byId.get(ev.sectionId) ?? null, ev));
    const evidenceValid = evidence.some((e) => e.valid);

    const targetType = targetTypeFor(record.kind);
    const existing = await this.resolveExistingTarget(projectId, record, targetType);
    const fields = planFieldMappings(targetType, record, existing.fields);
    const unsupportedFields = unsupportedFieldsFor(targetType);
    const alreadyIntegrated = record.integration.status === 'applied';

    const fingerprint = computeFingerprint({
      record,
      reviewStatus: record.reviewStatus,
      documentHash: hashRawText(document.rawText),
      targetType,
      existingId: existing.id,
      existingSignature: existing.signature,
      fields,
      fieldStrategies,
    });

    return {
      extractionId: record.id,
      projectId,
      record,
      reviewStatus: record.reviewStatus,
      document,
      evidence,
      evidenceValid,
      plan: {
        targetType,
        expectedAction: existing.id ? 'update' : 'create',
        existingMatch: existing.id ? { id: existing.id, label: existing.label } : null,
        fields,
        unsupportedFields,
        conflictCount: fields.filter((f) => f.conflict).length,
      },
      alreadyIntegrated,
      fingerprint,
      generatedAt: now(),
    };
  }

  /* -------------------------------- Apply --------------------------------- */

  /**
   * Applies a previously generated preview. Requires the preview fingerprint;
   * re-reads and re-validates everything INSIDE the transaction and refuses
   * (`stale-preview`) when the state has changed, so a stale preview can never
   * write.
   */
  async applyIntegration(
    projectId: string,
    extractionId: string,
    input: ApplyIntegrationInput,
  ): Promise<IntegrationItemResult> {
    if (!input.previewFingerprint) {
      throw new IntegrationValidationError(
        'missing-preview',
        `Applying extraction "${extractionId}" requires a preview fingerprint.`,
      );
    }
    return this.runAndStamp(projectId, extractionId, {
      mode: 'apply',
      previewFingerprint: input.previewFingerprint,
      targetId: input.targetId,
      fieldStrategies: input.fieldStrategies ?? {},
    });
  }

  /* --------------------------- Legacy entry points ------------------------ */

  /** Integrates ONE confirmed record (throws with a precise reason on refusal). */
  async integrateExtraction(projectId: string, extractionId: string): Promise<IntegrationItemResult> {
    const record = await this.requireExtraction(projectId, extractionId);
    this.assertIntegrable(projectId, record);
    if (record.integration.status === 'applied') {
      // Idempotent: re-applying an already-integrated record is a no-op that
      // returns its current target rather than writing a second entity.
      return {
        extractionId: record.id,
        record,
        target: {
          type: record.integration.appliedEntityType as IntegrationItemResult['target']['type'],
          id: record.integration.appliedEntityId ?? '',
        },
        applied: 'updated',
        conflicts: record.integration.conflicts ?? [],
        resolutions: record.integration.resolutions ?? [],
        confirmedFingerprint: record.integrationAudit?.previewFingerprint ?? '',
      };
    }
    return this.runAndStamp(projectId, extractionId, {
      mode: 'legacy',
      fieldStrategies: {},
    });
  }

  /**
   * Integrates several records. Each is processed INDEPENDENTLY (one failing
   * record never aborts the batch); the result reports counts + per-item
   * outcomes + explicit failures. Records that are not confirmed / already
   * applied are skipped.
   */
  async integrateMany(projectId: string, extractionIds: string[]): Promise<IntegrationBatchResult> {
    const items: IntegrationItemResult[] = [];
    const records: ExtractionRecord[] = [];
    const failures: IntegrationBatchResult['failures'] = [];
    let skipped = 0;

    for (const id of extractionIds) {
      let record: ExtractionRecord;
      try {
        record = await this.requireExtraction(projectId, id);
      } catch {
        skipped += 1;
        continue;
      }
      if (record.reviewStatus !== 'confirmed' || record.integration.status === 'applied') {
        skipped += 1;
        continue;
      }
      try {
        const item = await this.runAndStamp(projectId, id, { mode: 'legacy', fieldStrategies: {} });
        items.push(item);
        records.push(item.record);
      } catch (error) {
        failures.push(this.describeFailure(id, error));
      }
    }

    return { integrated: items.length, skipped, items, records, failures };
  }

  /**
   * Applies a batch of EXPLICIT user-confirmed applies (each with its own
   * preview fingerprint). Per-record independence mirrors `integrateMany`; a
   * stale preview is reported as a failure for that record only.
   */
  async applyMany(
    projectId: string,
    applies: Array<{ extractionId: string } & ApplyIntegrationInput>,
  ): Promise<IntegrationBatchResult> {
    const items: IntegrationItemResult[] = [];
    const records: ExtractionRecord[] = [];
    const failures: IntegrationBatchResult['failures'] = [];
    let skipped = 0;

    for (const apply of applies) {
      try {
        const item = await this.applyIntegration(projectId, apply.extractionId, {
          previewFingerprint: apply.previewFingerprint,
          targetId: apply.targetId,
          fieldStrategies: apply.fieldStrategies,
        });
        items.push(item);
        records.push(item.record);
      } catch (error) {
        if (error instanceof IntegrationValidationError && error.reason === 'already-applied') {
          skipped += 1;
          continue;
        }
        failures.push(this.describeFailure(apply.extractionId, error));
      }
    }

    return { integrated: items.length, skipped, items, records, failures };
  }

  /* ---------------------------- transaction core -------------------------- */

  /**
   * Runs the routing + write inside ONE transaction and stamps the record.
   * Shared by legacy and apply modes; the mode only decides whether the
   * preview fingerprint / field strategies are enforced.
   */
  private async runAndStamp(
    projectId: string,
    extractionId: string,
    options: {
      mode: 'legacy' | 'apply';
      previewFingerprint?: string;
      targetId?: string;
      fieldStrategies: Record<string, ConflictStrategy>;
    },
  ): Promise<IntegrationItemResult> {
    // Resolve the target type up-front (pure) so the transaction can scope the
    // right entity table. The record is RE-READ inside the transaction.
    const pre = await this.requireExtraction(projectId, extractionId);
    const targetType = targetTypeFor(pre.kind);
    const entityTable = this.entityTableFor(targetType);

    return this.runEntityTransaction(entityTable, async () => {
      // ---- 1. Re-read the record INSIDE the transaction ----
      const record = await this.repository.getExtractionById(extractionId);
      if (!record || record.projectId !== projectId) throw new IntegrationNotFoundError(extractionId);

      // ---- 2. Re-check review status / one-shot apply ----
      if (options.mode === 'apply' && record.integration.status === 'applied') {
        throw new IntegrationValidationError(
          'already-applied',
          `Extraction "${record.id}" was already integrated; re-applying is refused.`,
        );
      }
      this.assertIntegrable(projectId, record);

      const routedType = targetTypeFor(record.kind);
      if (routedType !== targetType) {
        throw new IntegrationValidationError(
          'wrong-target',
          `Extraction "${record.id}" routes to "${routedType}", not "${targetType}".`,
        );
      }

      // ---- 3. Re-validate evidence against the CURRENT text ----
      const document = await this.importService.getDocument(projectId, record.documentId);
      if (!document) {
        throw new IntegrationValidationError(
          'invalid-evidence',
          `Extraction "${record.id}" cites a document that no longer exists.`,
        );
      }
      const validEvidence = await this.revalidateEvidence(projectId, record, document);

      // ---- 4. Re-resolve target + conflicts, recompute fingerprint ----
      const existing = await this.resolveExistingTarget(projectId, record, routedType);
      const fields = planFieldMappings(routedType, record, existing.fields);
      const unsupportedFields = unsupportedFieldsFor(routedType);
      const documentHash = hashRawText(document.rawText);
      const fingerprint = computeFingerprint({
        record,
        reviewStatus: record.reviewStatus,
        documentHash,
        targetType: routedType,
        existingId: existing.id,
        existingSignature: existing.signature,
        fields,
        fieldStrategies: options.fieldStrategies,
      });

      if (options.mode === 'apply' && fingerprint !== options.previewFingerprint) {
        throw new IntegrationValidationError(
          'stale-preview',
          `The preview for extraction "${record.id}" is stale (the record, its evidence, the target entity or your field choices changed). Regenerate the preview before applying.`,
        );
      }
      if (options.targetId && options.targetId !== existing.id) {
        throw new IntegrationValidationError(
          'wrong-target',
          `The preview was generated for a different target entity ("${existing.id ?? 'new'}").`,
        );
      }

      // ---- 5. Apply the field strategies (default = conservative) ----
      //   apply : unspecified fields keep their existing value (explicit consent
      //           is required for any overwrite -> `keep-existing`).
      //   legacy: unspecified fields are filled from the extraction
      //           (`fill-empty-only`: carry values into a NEW entity, but never
      //           overwrite an existing one).
      const resolutions = resolveFields(
        fields,
        options.fieldStrategies,
        unsupportedFields,
        options.mode === 'apply' ? 'keep-existing' : 'fill-empty-only',
      );

      // ---- 6. Write the entity ----
      let written: WrittenEntity;
      if (routedType === 'character') {
        written = await this.writeCharacter(projectId, record, existing.character, resolutions);
      } else if (routedType === 'world-section') {
        written = await this.writeWorldSection(projectId, record, existing.world, existing.sectionId, resolutions);
      } else {
        written = await this.writeKnowledgeEntry(projectId, record, validEvidence, existing.entry, resolutions);
      }

      // ---- 7. Stamp the record + integration audit trail ----
      const conflicts = fields
        .filter((f) => f.conflict)
        .map((f) => ({
          field: f.field,
          existing: f.existing.slice(0, 4_000),
          incoming: f.incoming.slice(0, 4_000),
        }));
      const appliedAt = now();
      const auditFingerprint = options.mode === 'apply' && options.previewFingerprint ? options.previewFingerprint : fingerprint;

      const next: ExtractionRecord = {
        ...record,
        projectId,
        integration: {
          status: 'applied',
          appliedEntityType: routedType,
          appliedEntityId: written.id,
          appliedAt,
          ...(conflicts.length > 0 ? { conflicts } : {}),
          ...(resolutions.length > 0 ? { resolutions } : {}),
        },
        integrationAudit: {
          previewFingerprint: auditFingerprint,
          recordFingerprint: hashRawText(
            JSON.stringify({ id: record.id, updatedAt: record.updatedAt, title: record.title }),
          ),
          documentHash,
          fieldStrategies: options.fieldStrategies,
          resolutions,
          appliedAt,
        },
        updatedAt: appliedAt,
      };
      this.validateRecord(next);
      const stamped = await this.repository.updateExtraction(next);

      return {
        extractionId: record.id,
        record: stamped,
        target: { type: routedType, id: written.id },
        applied: written.created ? 'created' : 'updated',
        conflicts,
        resolutions,
        confirmedFingerprint: auditFingerprint,
      };
    });
  }

  /* --------------------------- target resolution -------------------------- */

  /**
   * Resolves the entity a record matches TODAY. Runs inside the transaction for
   * apply (so the fingerprint is computed against transaction-visible data) and
   * outside it for preview. Pure reads only.
   */
  private async resolveExistingTarget(
    projectId: string,
    record: ExtractionRecord,
    targetType: IntegrationTargetType,
  ): Promise<ResolvedTarget> {
    const blank: ExistingTargetFields = { summary: '', background: '', tags: [] };
    const none = (): ResolvedTarget => ({
      id: null,
      label: '',
      signature: 'new',
      fields: blank,
      character: null,
      world: null,
      sectionId: null,
      entry: null,
    });

    if (targetType === 'character') {
      const character = (await this.characterRepository.getByProjectId(projectId)).find((c) =>
        sameValue(c.name, record.title),
      );
      if (!character) return none();
      return {
        id: character.id,
        label: character.name,
        signature: `character:${character.id}:${character.updatedAt}`,
        fields: { summary: character.summary, background: character.background, tags: character.tags },
        character,
        world: null,
        sectionId: null,
        entry: null,
      };
    }

    if (targetType === 'world-section') {
      const world = await this.worldRepository.getByProjectId(projectId);
      const title = clampSectionTitle(record.title || 'Untitled');
      const section = world?.sections.find((s) => sameValue(s.title, title)) ?? null;
      // A world may already exist WITHOUT this section: the record still appends
      // a fresh section to it, so the resolved target must carry the world (and
      // its signature) even when no matching section was found.
      return {
        id: section ? section.id : null,
        label: section ? section.title : '',
        signature: world ? `world-section:${section?.id ?? 'new'}:${world.updatedAt}` : 'new',
        fields: section ? { summary: section.content, background: '', tags: [] } : blank,
        character: null,
        world,
        sectionId: section ? section.id : null,
        entry: null,
      };
    }

    // Knowledge entry -- matched by the deterministic source key.
    const sourceKey = knowledgeSourceKeyFor(record.kind, record.id);
    const entry = await this.knowledgeRepository.getBySourceKey(projectId, sourceKey);
    if (!entry) return none();
    return {
      id: entry.id,
      label: entry.title,
      signature: `knowledge-entry:${entry.id}:${entry.updatedAt}`,
      fields: { summary: entry.summary, background: '', tags: [] },
      character: null,
      world: null,
      sectionId: null,
      entry,
    };
  }

  /* ------------------------------ entity writes --------------------------- */

  /** Creates or updates a `Character`, honouring the field resolutions. */
  private async writeCharacter(
    projectId: string,
    record: ExtractionRecord,
    existing: Character | null,
    resolutions: ConflictResolution[],
  ): Promise<WrittenEntity> {
    const timestamp = now();
    if (!existing) {
      const character: Character = {
        id: createCharacterId(),
        projectId,
        name: clampTitle(record.title),
        summary: resolutionValue(resolutions, 'summary', record.summary).slice(0, 500),
        background: resolutionValue(resolutions, 'background', record.body),
        personality: '',
        motivation: '',
        appearance: '',
        role: 'supporting',
        status: 'active',
        tags: resolutionTags(resolutions, record.tags.slice(0, 50)),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.characterRepository.create(character);
      return { id: character.id, created: true };
    }

    const next: Character = {
      ...existing,
      summary: resolutionValue(resolutions, 'summary', existing.summary).slice(0, 500),
      background: resolutionValue(resolutions, 'background', existing.background),
      tags: resolutionTags(resolutions, existing.tags),
      updatedAt: timestamp,
    };
    await this.characterRepository.update(next);
    return { id: existing.id, created: false };
  }

  /**
   * Creates a `World` (with its first section) or updates the matched section.
   * Only the SECTION CONTENT is ever resolved/written; the world overview and
   * section titles are never overwritten from an extraction.
   */
  private async writeWorldSection(
    projectId: string,
    record: ExtractionRecord,
    world: World | null,
    sectionId: string | null,
    resolutions: ConflictResolution[],
  ): Promise<WrittenEntity> {
    const timestamp = now();
    const title = clampSectionTitle(record.title || 'Untitled');
    const content = resolutionValue(resolutions, 'content', worldSectionContent(record));

    if (!world || !sectionId || !world.sections.some((s) => s.id === sectionId)) {
      const newSectionId = createWorldSectionId();
      if (!world) {
        const created: World = {
          id: createWorldId(),
          projectId,
          title: 'Imported world',
          overview: '',
          sections: [{ id: newSectionId, title, content }],
          themes: [],
          settings: {},
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.worldRepository.create(created);
        return { id: newSectionId, created: true };
      }
      const sections = [...world.sections, { id: newSectionId, title, content }];
      await this.worldRepository.update({ ...world, sections: sections.slice(0, 50), updatedAt: timestamp });
      return { id: newSectionId, created: true };
    }

    const sections = world.sections.map((s) => (s.id === sectionId ? { ...s, content } : s));
    await this.worldRepository.update({ ...world, sections, updatedAt: timestamp });
    return { id: sectionId, created: false };
  }

  /**
   * Creates or refreshes a `KnowledgeEntry`. A knowledge entry IS the extraction
   * index, so its body/title always mirror the record; only the SUMMARY field
   * participates in conflict resolution.
   */
  private async writeKnowledgeEntry(
    projectId: string,
    record: ExtractionRecord,
    evidence: ExtractionRecord['evidence'],
    existing: KnowledgeEntry | null,
    resolutions: ConflictResolution[],
  ): Promise<WrittenEntity> {
    const sourceKey = knowledgeSourceKeyFor(record.kind, record.id);
    const timestamp = now();
    const { title, summary: proposedSummary } = knowledgeFields(record);
    const summary = resolutionValue(resolutions, 'summary', proposedSummary);

    const knowledgeEvidence = evidence.map((ev) => ({
      chapterId: null,
      sceneId: null,
      quote: ev.quote ?? '',
      offset: null,
      note: `Imported from document section ${ev.sectionId}.`,
      source: { documentId: ev.documentId, sectionId: ev.sectionId, start: ev.start, end: ev.end },
    }));

    const entry: KnowledgeEntry = {
      id: existing?.id ?? createKnowledgeEntryId(),
      projectId,
      kind: knowledgeKindFor(record.kind),
      title,
      summary,
      body: record.body,
      tags: record.tags,
      source: 'manual',
      sourceRef: { entityType: 'manual', entityId: record.id, key: sourceKey },
      sourceKey,
      evidence: knowledgeEvidence,
      searchText: deriveSearchText({ title, summary, body: record.body, tags: record.tags }),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (existing) {
      await this.knowledgeRepository.update(entry);
      return { id: entry.id, created: false };
    }
    await this.knowledgeRepository.create(entry);
    return { id: entry.id, created: true };
  }

  /* ------------------------------- helpers -------------------------------- */

  private entityTableFor(targetType: IntegrationTargetType): unknown {
    if (targetType === 'character') return this.characterRepository.dexieTable;
    if (targetType === 'world-section') return this.worldRepository.dexieTable;
    return this.knowledgeRepository.dexieTable;
  }

  /**
   * Re-validates the record's evidence against the CURRENT raw text. At least one
   * locator must still resolve, else the record is ungrounded and refused.
   */
  private async revalidateEvidence(
    projectId: string,
    record: ExtractionRecord,
    document: SourceDocument,
  ): Promise<ExtractionRecord['evidence']> {
    const sections = await this.importService.getSections(projectId, record.documentId);
    const byId = new Map(sections.map((s) => [s.id, s]));
    const valid = record.evidence.filter((ev) => {
      const section = byId.get(ev.sectionId);
      return section ? evidenceStillValid(document, section, ev) : false;
    });
    if (valid.length === 0) {
      throw new IntegrationValidationError(
        'invalid-evidence',
        `Extraction "${record.id}" has no evidence that still resolves against the current document; refusing to integrate ungrounded data.`,
      );
    }
    return valid;
  }

  /** Refuses records that are not `confirmed` or not from this project. */
  private assertIntegrable(projectId: string, record: ExtractionRecord): void {
    if (record.projectId !== projectId) {
      throw new IntegrationValidationError(
        'cross-project',
        `Extraction "${record.id}" does not belong to project "${projectId}".`,
      );
    }
    if (record.reviewStatus !== 'confirmed') {
      throw new IntegrationValidationError(
        'not-confirmed',
        `Extraction "${record.id}" is "${record.reviewStatus}"; only confirmed records can be integrated.`,
      );
    }
  }

  /**
   * Runs `fn` inside ONE readwrite transaction spanning the import tables and the
   * supplied target-entity table, so an entity write + the record's `integration`
   * stamp commit (or roll back) together.
   */
  private async runEntityTransaction<T>(entityTable: unknown, fn: () => Promise<T>): Promise<T> {
    return this.repository.runExtractionTransaction(fn, [entityTable]);
  }

  private validateRecord(record: ExtractionRecord): void {
    const result = ExtractionRecordSchema.safeParse(record);
    if (!result.success) {
      throw new IntegrationValidationError(
        'invalid-fields',
        `Extraction is invalid: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
  }

  private describeFailure(extractionId: string, error: unknown): IntegrationBatchResult['failures'][number] {
    return {
      extractionId,
      reason: error instanceof IntegrationValidationError ? error.reason : ((error as Error)?.name ?? 'error'),
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private async listProjectExtractions(projectId: string): Promise<ExtractionRecord[]> {
    try {
      return await this.repository.listExtractionsByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list extractions of project "${projectId}"`);
    }
  }

  private async requireExtraction(projectId: string, id: string): Promise<ExtractionRecord> {
    try {
      const record = await this.repository.getExtractionById(id);
      if (!record || record.projectId !== projectId) throw new IntegrationNotFoundError(id);
      return record;
    } catch (error) {
      if (error instanceof IntegrationNotFoundError) throw error;
      throw this.wrap(error, `Failed to load extraction "${id}"`);
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof IntegrationServiceError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) return new ProjectValidationError(message, error.issues, error);
    return new IntegrationServiceError(message, error);
  }
}

export { knowledgeKindFor };
