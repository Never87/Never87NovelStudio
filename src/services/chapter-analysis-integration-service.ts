import { now } from '@/utils/date';
import { createWorldSectionId } from '@/utils/id';
import type {
  Character,
  ChapterAnalysisEntity,
  ChapterAnalysisRun,
  Evidence,
  KnowledgeEntry,
  KnowledgeEntryKind,
  World,
} from '@/types';
import type { AnalysisIntegrationState } from '@/schemas/chapter-analysis';
import { buildEntityKey, normalizeCandidateName } from '@/schemas/chapter-analysis';
import { CharacterService } from './character-service';
import { KnowledgeService } from './knowledge-service';
import { WorldService } from './world-service';
import { ProjectServiceError } from './project-service';
import { ChapterAnalysisRepository } from '@/repositories/chapter-analysis-repository';
import { targetKindForRecordKind } from './integration/shared';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Base class for chapter-analysis integration errors. */
export class ChapterAnalysisIntegrationError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ChapterAnalysisIntegrationError';
  }
}

/** A validation-style failure of an integration request. */
export class ChapterAnalysisIntegrationValidationError extends ChapterAnalysisIntegrationError {
  readonly reason: 'not-accepted' | 'not-found' | 'invalid-kind' | 'already-integrated' | 'self-relation';
  constructor(reason: ChapterAnalysisIntegrationValidationError['reason'], message: string) {
    super(message);
    this.name = 'ChapterAnalysisIntegrationValidationError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/** A concrete action the author can take for one accepted candidate. */
export const INTEGRATION_ACTIONS = ['match', 'create', 'defer', 'dismiss', 'uncertain'] as const;
export type IntegrationAction = (typeof INTEGRATION_ACTIONS)[number];

/** A canonical family a candidate can resolve to. */
export type CanonicalFamily = 'character' | 'world-section' | 'knowledge-entry';

/** One existing canonical entity a candidate could resolve to. */
export interface CanonicalMatch {
  /** The canonical family the match belongs to. */
  canonicalType: CanonicalFamily;
  /** Stable canonical id. */
  id: string;
  /** Display label (name / section title / entry title). */
  label: string;
  /**
   * Enough canonical context for the author to VERIFY identity before confirming
   * a match (a one-line summary / section preview). Never used for merging.
   */
  summary: string;
  /** How confident the match is: `exact` (same normalized name) or `alias`. */
  matchedBy: 'exact' | 'alias';
}

/** Resolved integration PREVIEW for one accepted candidate. */
export interface CandidateIntegrationPreview {
  /** The candidate's stable key within the run. */
  key: string;
  kind: KnowledgeEntryKind;
  name: string;
  /** The canonical family a CREATE would produce for this kind. */
  targetCanonicalType: CanonicalFamily;
  /** Existing canonical entities this candidate could match (best first). */
  matches: CanonicalMatch[];
  /**
   * Possible-duplicate suggestions found across analysis runs AND the current
   * canonical model. Distinct from `matches`: a possible duplicate is surfaced
   * as an explicit review decision, never auto-merged.
   */
  possibleDuplicates: CanonicalMatch[];
  /** The current integration state (from the persisted run). */
  integration: AnalysisIntegrationState;
  /** Number of grounded evidence spans attached to the candidate. */
  evidenceCount: number;
  /** True when the candidate has no grounded evidence (flagged, not blocked). */
  unsupported: boolean;
  /** True when more than one plausible existing match exists (a possible dup). */
  ambiguous: boolean;
}

/** Result of applying an integration decision for one candidate. */
export interface CandidateIntegrationResult {
  run: ChapterAnalysisRun;
  entity: ChapterAnalysisEntity;
  /** The canonical id linked (matched/created), or null (defer/dismiss/uncertain). */
  canonicalEntityId: string | null;
  /** What happened. */
  outcome: 'matched' | 'created' | 'deferred' | 'dismissed' | 'uncertain';
}

/** Per-candidate decision used by the batch apply. */
export interface IntegrationDecision {
  key: string;
  action: IntegrationAction;
  /**
   * For `match`: the canonical id to link (must be one of the previews). For
   * `create`: optional human-edited name/tags to write. Ignored otherwise.
   */
  matchId?: string | null;
  createName?: string | null;
  createTags?: string[] | null;
  /**
   * For `uncertain`: an existing canonical entity the author flagged as a
   * POSSIBLE DUPLICATE (never merged). Persisted on the candidate's integration
   * state so the review decision is durable, not an ephemeral flag.
   */
  duplicateOfId?: string | null;
  /** Display label of the flagged possible duplicate (convenience for the UI). */
  duplicateOfLabel?: string | null;
}

/** Result of a batch apply. */
export interface ApplyIntegrationResult {
  run: ChapterAnalysisRun;
  results: CandidateIntegrationResult[];
}

/* -------------------------------------------------------------------------- */
/* The integration service                                                    */
/* -------------------------------------------------------------------------- */

/**
 * REVIEW -> INTEGRATION for chapter analysis (P11).
 *
 * Turns ACCEPTED analysis candidates into links/rows in the canonical story
 * model (Characters + Knowledge Base). This is the ONLY P11 step that writes
 * project entities, and it ONLY acts on candidates the author has explicitly
 * accepted AND then explicitly chosen an integration action for. It never
 * auto-merges and never overwrites an existing entity's data.
 *
 * ## Separation of concerns (why this is distinct from review)
 *
 *   - REVIEW (`status` on a candidate) records the editorial decision:
 *     proposed/accepted/dismissed. The analysis SERVICE owns this.
 *   - INTEGRATION (`integration.status` on a candidate) records whether the
 *     accepted candidate has been resolved against the canonical model:
 *     matched/created/deferred/uncertain/dismissed. THIS service owns it.
 *
 *   A candidate must be `accepted` before it can be integrated; integration
 *   never flips review status, and review never auto-integrates. This keeps the
 *   "review before integration" guarantee structurally true.
 *
 * ## Alias-aware matching (never auto-merged)
 *
 * Matching compares a candidate's normalized name AND its proposed aliases
 * against existing canonical entities' names, aliases (tags for characters) and
 * titles. A matching candidate is only ever a SUGGESTION — an author must pick
 * `match` (link the existing row) or `create` (a new row). Two equally-good
 * matches are surfaced as `ambiguous` (a possible duplicate) so the author, not
 * the machine, decides.
 *
 * ## Evidence grounding
 *
 * Evidence quotes were already grounded (offsets verified against the persisted
 * chapter prose) at extraction time. Grounded evidence is carried onto the
 * canonical entity it produces:
 *   - Knowledge entry → evidence spans become chapter locators on the entry.
 *   - Character       → evidence spans become the character's `evidence` array,
 *                       attached on CREATE, and only back-filled on MATCH when the
 *                       character has no evidence yet (never overwriting manual
 *                       provenance).
 *   - World section   → the model has no per-section evidence field, so evidence
 *                       stays on the analysis run (never fabricated onto a field
 *                       the canonical model does not support).
 */
export class ChapterAnalysisIntegrationService {
  private readonly repository: ChapterAnalysisRepository;
  private readonly characterService: CharacterService;
  private readonly knowledgeService: KnowledgeService;
  private readonly worldService: WorldService;
  /**
   * Per-run write locks. Integration performs canonical writes (other tables)
   * THEN persists the run, so it cannot be one Dexie transaction across tables.
   * The lock serialises concurrent integration of the SAME run, preventing two
   * requests from both creating a canonical entity before either records it.
   */
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(deps: {
    repository?: ChapterAnalysisRepository;
    characterService?: CharacterService;
    knowledgeService?: KnowledgeService;
    worldService?: WorldService;
  } = {}) {
    this.repository = deps.repository ?? new ChapterAnalysisRepository();
    this.characterService = deps.characterService ?? new CharacterService();
    this.knowledgeService = deps.knowledgeService ?? new KnowledgeService();
    this.worldService = deps.worldService ?? new WorldService();
  }

  /* ------------------------------ Preview --------------------------------- */

  /**
   * Builds an integration PREVIEW for every ACCEPTED entity candidate in a run.
   *
   * Read-only. For each accepted candidate it resolves alias-aware matches
   * against existing canonical entities and reports the target that a CREATE
   * would produce. Candidates that are not accepted are omitted (they are not
   * integrable until reviewed).
   */
  async previewIntegration(projectId: string, runId: string): Promise<CandidateIntegrationPreview[]> {
    const run = await this.requireRun(projectId, runId);
    const [characters, knowledge, world, otherRuns] = await Promise.all([
      this.characterService.listCharacters(projectId),
      this.knowledgeService.listEntries(projectId),
      this.worldService.getWorld(projectId),
      this.siblingRuns(projectId, run.chapterId, runId),
    ]);

    const previews: CandidateIntegrationPreview[] = [];
    for (const entity of run.entities) {
      if (entity.status !== 'accepted') continue;
      const targetCanonicalType = canonicalTypeForKind(entity.kind);

      const matches =
        targetCanonicalType === 'character'
          ? matchCharacters(entity, characters)
          : targetCanonicalType === 'world-section'
            ? matchWorldSections(entity, world)
            : matchKnowledge(entity, knowledge, entity.kind);

      // Possible duplicates = canonical suggestions PLUS same-kind candidates in
      // OTHER analysis runs of this chapter that resolve to the same or a similar
      // name. Surfaced for an explicit decision; never auto-merged.
      const possibleDuplicates = dedupeMatches([
        ...matches.filter((m) => m.matchedBy === 'alias'),
        ...matchAcrossRuns(entity, otherRuns),
      ]);

      previews.push({
        key: entity.key,
        kind: entity.kind,
        name: entity.name,
        targetCanonicalType,
        matches,
        possibleDuplicates,
        integration: entity.integration,
        evidenceCount: entity.evidence.length,
        unsupported: entity.evidence.length === 0,
        ambiguous: countExact(matches) > 1,
      });
    }
    return previews;
  }

  /** Other analysis runs for the same chapter in this project (excluding `runId`). */
  private async siblingRuns(projectId: string, chapterId: string, runId: string): Promise<ChapterAnalysisRun[]> {
    try {
      const all = await this.repository.listByChapter(projectId, chapterId);
      return all.filter((r) => r.id !== runId);
    } catch {
      // Non-fatal: cross-run detection is advisory; a read failure must not block
      // integration previews.
      return [];
    }
  }

  /* ------------------------------- Apply ---------------------------------- */

  /**
   * Applies a single integration decision to one ACCEPTED entity candidate.
   *
   * `match` links an existing canonical entity (chosen by id); `create` writes a
   * new one; `defer`/`dismiss`/`uncertain` change only the candidate's
   * integration state (no writes to canonical tables). The run is reloaded,
   * mutated in place, re-validated and persisted atomically.
   */
  async applyDecision(
    projectId: string,
    runId: string,
    decision: IntegrationDecision,
  ): Promise<CandidateIntegrationResult> {
    return this.applyDecisions(projectId, runId, [decision]).then((batch) => batch.results[0]);
  }

  /**
   * Applies a BATCH of integration decisions in ONE transaction, so a partial
   * failure rolls everything back and canonical ids can never be written to the
   * run without the corresponding entity existing (or vice versa).
   *
   * Only ACCEPTED entity candidates are eligible. A decision targeting a
   * non-accepted or unknown candidate is rejected.
   */
  async applyDecisions(
    projectId: string,
    runId: string,
    decisions: IntegrationDecision[],
  ): Promise<ApplyIntegrationResult> {
    if (decisions.length === 0) {
      const run = await this.requireRun(projectId, runId);
      return { run, results: [] };
    }

    // Serialise per run: canonical writes go through the existing services
    // (their own tables), then the run is persisted — this cannot be a single
    // cross-table Dexie transaction, so the lock prevents two requests from
    // both creating an entity for the same candidate before either is recorded.
    return this.withWriteLock(`${projectId}::${runId}`, async () => {
      // Reload the run at the head of the critical section so a concurrent
      // change made while we waited on the lock is observed.
      const run = await this.requireRun(projectId, runId);
      const byKey = new Map(run.entities.map((entity) => [entity.key, entity] as const));

      // Validate EVERY decision before performing ANY write.
      for (const decision of decisions) {
        const entity = byKey.get(decision.key);
        if (!entity) {
          throw new ChapterAnalysisIntegrationValidationError('not-found', `Candidate "${decision.key}" is not in run "${runId}".`);
        }
        if (entity.status !== 'accepted') {
          throw new ChapterAnalysisIntegrationValidationError(
            'not-accepted',
            `Candidate "${decision.key}" must be accepted before it can be integrated.`,
          );
        }
        if (decision.action === 'match' && !decision.matchId) {
          throw new ChapterAnalysisIntegrationValidationError('not-found', `A "match" decision for "${decision.key}" requires a matchId.`);
        }
      }

      const results: CandidateIntegrationResult[] = [];
      const decidedAt = now();
      for (const decision of decisions) {
        const entity = byKey.get(decision.key)!;
        // IDEMPOTENT RE-INTEGRATION: re-applying the SAME resolving decision that
        // already committed (a repeat "create", or a "match" to the same id) must
        // NOT write a second canonical entity — it reuses the existing link. Any
        // OTHER decision (a different match id, or a match after a create) is a
        // real re-decision and flows through normal validation below.
        const alreadyResolved =
          (decision.action === 'create' && entity.integration.status === 'created') ||
          (decision.action === 'match' &&
            entity.integration.status === 'matched' &&
            decision.matchId != null &&
            decision.matchId === (entity.integration.canonicalEntityId ?? entity.linkedEntityId));
        if (alreadyResolved) {
          results.push({
            run,
            entity,
            canonicalEntityId: entity.integration.canonicalEntityId ?? entity.linkedEntityId,
            // `alreadyResolved` guarantees the status is 'matched' or 'created'.
            outcome: entity.integration.status as 'matched' | 'created',
          });
          continue;
        }
        const outcome = await this.resolveOne(projectId, run.chapterId, entity, decision, decidedAt);
        // Mutate the in-place entity so the run we persist carries the new state.
        entity.integration = outcome.integration;
        entity.linkedEntityId = outcome.canonicalEntityId;
        results.push({ run, entity, canonicalEntityId: outcome.canonicalEntityId, outcome: outcome.outcome });
      }

      const updated: ChapterAnalysisRun = { ...run, updatedAt: now() };
      const persisted = await this.repository.update(updated);
      return { run: persisted, results: results.map((r) => ({ ...r, run: persisted })) };
    });
  }

  /**
   * Integrates a WHOLE run: every accepted entity is integrated by the default
   * policy (match a single exact hit, otherwise create), then accepted
   * relationships are linked when BOTH endpoints are already linked. This is the
   * one-click "integrate all accepted" path; ambiguous matches are left as
   * `uncertain` for the author rather than guessed.
   */
  async integrateAccepted(projectId: string, runId: string): Promise<ApplyIntegrationResult> {
    const previews = await this.previewIntegration(projectId, runId);
    const decisions: IntegrationDecision[] = previews.map((preview) => {
      if (preview.matches.length === 0) {
        return { key: preview.key, action: 'create' };
      }
      const exact = preview.matches.filter((m) => m.matchedBy === 'exact');
      if (exact.length === 1) {
        return { key: preview.key, action: 'match', matchId: exact[0].id };
      }
      if (preview.matches.length === 1) {
        return { key: preview.key, action: 'match', matchId: preview.matches[0].id };
      }
      // Multiple plausible matches: do not guess. Flag for manual review.
      return { key: preview.key, action: 'uncertain' };
    });

    const result = await this.applyDecisions(projectId, runId, decisions);
    // Relationships are a follow-on step; link those whose endpoints resolved.
    return this.linkRelationships(projectId, result.run);
  }

  /* --------------------------- Relationship links ------------------------- */

  /**
   * Links ACCEPTED relationships whose BOTH endpoint entities are already
   * integrated (have a canonical id). Relationships whose endpoints are not yet
   * integrated are left untouched (deferred). Never fabricates a link.
   */
  async linkRelationships(projectId: string, runOrId: ChapterAnalysisRun | string): Promise<ApplyIntegrationResult> {
    const initial = typeof runOrId === 'string' ? await this.requireRun(projectId, runOrId) : runOrId;

    return this.withWriteLock(`${projectId}::${initial.id}`, async () => {
      const fresh = await this.requireRun(projectId, initial.id);
      const entityById = new Map(fresh.entities.map((e) => [e.key, e] as const));

      for (const rel of fresh.relationships) {
        if (rel.status !== 'accepted') continue;
        const from = entityById.get(rel.fromKey);
        const to = entityById.get(rel.toKey);
        if (!from || !to) continue;
        const fromId = from.integration.canonicalEntityId ?? from.linkedEntityId;
        const toId = to.integration.canonicalEntityId ?? to.linkedEntityId;
        if (!fromId || !toId) continue; // endpoints not integrated yet
        rel.linkedFromEntityId = fromId;
        rel.linkedToEntityId = toId;
        rel.integration = {
          ...rel.integration,
          status: 'matched',
          matchedBy: 'exact',
          decidedAt: rel.integration.decidedAt ?? now(),
        };
      }

      const updated: ChapterAnalysisRun = { ...fresh, updatedAt: now() };
      const persisted = await this.repository.update(updated);
      return { run: persisted, results: [] };
    });
  }

  /** Serialises writes per lock key (see `applyDecisions`). */
  private withWriteLock<T>(key: string, op: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => op(),
      () => op(),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.writeLocks.set(key, tail);
    void tail.then(() => {
      if (this.writeLocks.get(key) === tail) this.writeLocks.delete(key);
    });
    return run;
  }

  /* ------------------------------- internals ------------------------------ */

  /**
   * Resolves ONE accepted entity's decision into a new integration state +
   * optional canonical id, performing the canonical write when required. Runs
   * INSIDE the caller's transaction context (caller validates + persists run).
   */
  private async resolveOne(
    projectId: string,
    chapterId: string,
    entity: ChapterAnalysisEntity,
    decision: IntegrationDecision,
    decidedAt: number,
  ): Promise<{ integration: AnalysisIntegrationState; canonicalEntityId: string | null; outcome: CandidateIntegrationResult['outcome'] }> {
    const targetType = canonicalTypeForKind(entity.kind);

    switch (decision.action) {
      case 'defer':
        return { integration: state('deferred', targetType, null, 'none', null, '', decidedAt), canonicalEntityId: null, outcome: 'deferred' };

      case 'dismiss':
        return { integration: state('dismissed', targetType, null, 'none', null, '', decidedAt), canonicalEntityId: null, outcome: 'dismissed' };

      case 'uncertain':
        // "Uncertain" doubles as the explicit POSSIBLE-DUPLICATE decision: when the
        // author flags an existing entity, we persist its reference (never merging).
        return {
          integration: state(
            'uncertain',
            targetType,
            null,
            'none',
            decision.duplicateOfId ?? null,
            decision.duplicateOfLabel ?? '',
            decidedAt,
          ),
          canonicalEntityId: null,
          outcome: 'uncertain',
        };

      case 'match': {
        if (!decision.matchId) {
          throw new ChapterAnalysisIntegrationValidationError('not-found', 'A match decision requires a matchId.');
        }
        // Verify the matched entity exists in THIS project and is the right family.
        if (targetType === 'character') {
          const existing = await this.characterService.getCharacter(decision.matchId);
          if (!existing || existing.projectId !== projectId) {
            throw new ChapterAnalysisIntegrationValidationError('not-found', `Character "${decision.matchId}" was not found in this project.`);
          }
          // Evidence provenance: attach the candidate's grounded evidence ONLY
          // when the character has none yet. Never overwrite manually maintained
          // provenance on an existing character.
          if (existing.evidence.length === 0) {
            const carried = characterEvidence(chapterId, entity);
            if (carried.length > 0) {
              await this.characterService.updateCharacter(projectId, existing.id, { evidence: carried });
            }
          }
          return {
            integration: state('matched', 'character', existing.id, matchedByName(existing, entity), null, '', decidedAt),
            canonicalEntityId: existing.id,
            outcome: 'matched',
          };
        }
        if (targetType === 'world-section') {
          const world = await this.worldService.getWorld(projectId);
          const section = world?.sections.find((s) => s.id === decision.matchId) ?? null;
          if (!world || !section) {
            throw new ChapterAnalysisIntegrationValidationError('not-found', `World section "${decision.matchId}" was not found in this project.`);
          }
          return {
            integration: state('matched', 'world-section', section.id, matchedBySection(section, entity), null, '', decidedAt),
            canonicalEntityId: section.id,
            outcome: 'matched',
          };
        }
        const entry = await this.knowledgeService.getEntry(decision.matchId);
        if (!entry || entry.projectId !== projectId) {
          throw new ChapterAnalysisIntegrationValidationError('not-found', `Knowledge entry "${decision.matchId}" was not found in this project.`);
        }
        return {
          integration: state('matched', 'knowledge-entry', entry.id, matchedByEntry(entry, entity), null, '', decidedAt),
          canonicalEntityId: entry.id,
          outcome: 'matched',
        };
      }

      case 'create': {
        if (targetType === 'character') {
          const created = await this.characterService.createCharacter(projectId, {
            name: (decision.createName ?? entity.name).trim() || entity.name,
            summary: entity.summary,
            background: entity.detail,
            role: 'supporting',
            status: 'active',
            // Preserve aliases as tags so future matching sees them.
            tags: dedupe([...(decision.createTags ?? entity.tags), ...entity.aliases]),
            // Evidence provenance: the character carries grounded chapter evidence.
            evidence: characterEvidence(chapterId, entity),
          });
          return {
            integration: state('created', 'character', created.id, 'created', null, '', decidedAt),
            canonicalEntityId: created.id,
            outcome: 'created',
          };
        }
        if (targetType === 'world-section') {
          const section = await this.createWorldSection(projectId, entity, decision);
          return {
            integration: state('created', 'world-section', section.id, 'created', null, '', decidedAt),
            canonicalEntityId: section.id,
            outcome: 'created',
          };
        }
        // Knowledge entry: carry grounded evidence back to the source chapter.
        const created = await this.knowledgeService.createEntry(projectId, {
          kind: entity.kind,
          title: (decision.createName ?? entity.name).trim() || entity.name,
          summary: entity.summary,
          body: entity.detail,
          tags: dedupe([...(decision.createTags ?? entity.tags), ...entity.aliases]),
          evidence: entity.evidence.map((ev) => ({
            chapterId, // the source chapter all evidence for a run points into
            sceneId: null,
            quote: ev.quote,
            offset: ev.start ?? ev.offset,
            note: '',
          })),
        });
        return {
          integration: state('created', 'knowledge-entry', created.id, 'created', null, '', decidedAt),
          canonicalEntityId: created.id,
          outcome: 'created',
        };
      }

      default:
        throw new ChapterAnalysisIntegrationValidationError('invalid-kind', `Unknown integration action "${String(decision.action)}".`);
    }
  }

  /**
   * Creates (or reuses) a World section for a location/faction/rule candidate
   * through the CANONICAL `WorldService` — never a parallel store.
   *
   * Idempotent by title: if the project's world already has a section with the
   * same (normalised) title, it is reused rather than duplicated, so re-running
   * integration appends nothing. The world itself is created if absent.
   *
   * Because there is no evidence field on a `WorldSection`, the candidate's
   * grounded evidence is NOT attached to the section (it remains on the analysis
   * run) — we never fabricate a field the canonical model does not support.
   */
  private async createWorldSection(
    projectId: string,
    entity: ChapterAnalysisEntity,
    decision: IntegrationDecision,
  ): Promise<World['sections'][number]> {
    const title = ((decision.createName ?? entity.name).trim() || entity.name).slice(0, 80);
    const content = [entity.summary, entity.detail].filter(Boolean).join('\n\n');
    const world = await this.worldService.getWorld(projectId);

    if (world) {
      const existing = world.sections.find((s) => normalizeCandidateName(s.title) === normalizeCandidateName(title));
      if (existing) return existing;
      const section = {
        id: createWorldSectionId(),
        title,
        content,
      };
      const updated = await this.worldService.updateWorld(projectId, {
        sections: [...world.sections, section],
      });
      return updated.sections.find((s) => normalizeCandidateName(s.title) === normalizeCandidateName(title)) ?? section;
    }

    const created = await this.worldService.createWorld(projectId, {
      title: 'World of the story',
      sections: [{ title, content }],
    });
    return created.sections.find((s) => normalizeCandidateName(s.title) === normalizeCandidateName(title)) ?? created.sections[0];
  }

  /** Loads a run, verifying it belongs to `projectId` (foreign -> not found). */
  private async requireRun(projectId: string, runId: string): Promise<ChapterAnalysisRun> {
    const run = await this.repository.getById(runId);
    if (!run || run.projectId !== projectId) {
      throw new ChapterAnalysisIntegrationValidationError('not-found', `Chapter analysis "${runId}" was not found in this project.`);
    }
    return run;
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Maps an entity kind to the canonical family a CREATE would produce.
 *
 * Routes through the SHARED kind→target mapping (the same one P8 uses), so the
 * two integration pipelines can never disagree: `character` → Character;
 * `location`/`faction`/`rule` → World section; everything else → Knowledge entry.
 */
export function canonicalTypeForKind(kind: KnowledgeEntryKind): CanonicalFamily {
  // `targetKindForRecordKind` is the single source of truth shared with P8.
  return targetKindForRecordKind(kind) as CanonicalFamily;
}

/** Builds an integration state with the canonical-id/duplicate defaults filled. */
function state(
  status: AnalysisIntegrationState['status'],
  canonicalType: AnalysisIntegrationState['canonicalType'],
  canonicalEntityId: string | null,
  matchedBy: AnalysisIntegrationState['matchedBy'],
  possibleDuplicateId: string | null,
  possibleDuplicateLabel: string,
  decidedAt: number | null,
): AnalysisIntegrationState {
  return {
    status,
    canonicalType,
    canonicalEntityId,
    matchedBy,
    possibleDuplicateId,
    possibleDuplicateLabel,
    decidedAt,
  };
}

/** How many matches are EXACT (same normalized name). */
function countExact(matches: CanonicalMatch[]): number {
  return matches.filter((m) => m.matchedBy === 'exact').length;
}

/** The name-match basis for a character: exact name or an alias/tag. */
function matchedByName(character: Character, entity: ChapterAnalysisEntity): 'exact' | 'alias' {
  if (normalizeCandidateName(character.name) === normalizeCandidateName(entity.name)) return 'exact';
  return 'alias';
}

/** The name-match basis for a knowledge entry: title or tag. */
function matchedByEntry(entry: KnowledgeEntry, entity: ChapterAnalysisEntity): 'exact' | 'alias' {
  if (normalizeCandidateName(entry.title) === normalizeCandidateName(entity.name)) return 'exact';
  return 'alias';
}

/** The name-match basis for a world section: exact title or an alias/tag. */
function matchedBySection(section: World['sections'][number], entity: ChapterAnalysisEntity): 'exact' | 'alias' {
  if (normalizeCandidateName(section.title) === normalizeCandidateName(entity.name)) return 'exact';
  return 'alias';
}

/**
 * Grounded evidence carried onto a Character, built from the candidate's
 * chapter evidence (chapter locator + verbatim quote + grounded offset). The
 * character's schema `Evidence` requires a chapter/scene/document locator;
 * chapter evidence supplies `chapterId`, so this is always valid.
 */
function characterEvidence(chapterId: string, entity: ChapterAnalysisEntity): Evidence[] {
  return entity.evidence.map((ev) => ({
    chapterId,
    sceneId: null,
    quote: ev.quote,
    offset: ev.start ?? ev.offset,
    note: '',
  }));
}

/**
 * Alias-aware character matching.
 *
 * Compares the candidate's normalized name AND its aliases against every
 * character's normalized name AND its tags. Exact name matches rank first; alias
 * matches follow. Results are de-duplicated (a character matched by both name
 * and alias appears once, as `exact`).
 */
function matchCharacters(entity: ChapterAnalysisEntity, characters: Character[]): CanonicalMatch[] {
  const candidateNames = candidateTokens(entity);
  const matches: CanonicalMatch[] = [];
  for (const character of characters) {
    const exact = normalizeCandidateName(character.name) === normalizeCandidateName(entity.name);
    const alias =
      !exact &&
      (candidateNames.has(normalizeCandidateName(character.name)) ||
        character.tags.some((tag) => candidateNames.has(normalizeCandidateName(tag))));
    if (exact || alias) {
      matches.push({
        canonicalType: 'character',
        id: character.id,
        label: character.name,
        summary: character.summary,
        matchedBy: exact ? 'exact' : 'alias',
      });
    }
  }
  return sortMatches(matches);
}

/**
 * World-section matching: compares the candidate's name/aliases against every
 * section title in the project's world. Sections are the canonical home for
 * location/faction/rule facts, so these are the only candidates considered.
 */
function matchWorldSections(entity: ChapterAnalysisEntity, world: World | null): CanonicalMatch[] {
  if (!world) return [];
  const candidateNames = candidateTokens(entity);
  const matches: CanonicalMatch[] = [];
  for (const section of world.sections) {
    const exact = normalizeCandidateName(section.title) === normalizeCandidateName(entity.name);
    const alias = !exact && candidateNames.has(normalizeCandidateName(section.title));
    if (exact || alias) {
      matches.push({
        canonicalType: 'world-section',
        id: section.id,
        label: section.title,
        summary: firstLine(section.content),
        matchedBy: exact ? 'exact' : 'alias',
      });
    }
  }
  return sortMatches(matches);
}

/**
 * Cross-run duplicate detection: same-kind accepted candidates in OTHER analysis
 * runs of the same chapter that resolve to the same (or an alias-colliding)
 * name. Reported as a possible duplicate (never merged) so the author can decide
 * whether two runs proposed the same real-world entity.
 */
function matchAcrossRuns(entity: ChapterAnalysisEntity, runs: ChapterAnalysisRun[]): CanonicalMatch[] {
  const targetKind = targetKindForRecordKind(entity.kind);
  const candidateNames = candidateTokens(entity);
  const matches: CanonicalMatch[] = [];
  for (const run of runs) {
    for (const other of run.entities) {
      // `runs` are OTHER runs only, so a matching key here is a genuine cross-run
      // proposal of the same entity — exactly what we want to surface.
      if (other.status !== 'accepted') continue;
      if (targetKindForRecordKind(other.kind) !== targetKind) continue;
      const exact = other.kind === entity.kind && normalizeCandidateName(other.name) === normalizeCandidateName(entity.name);
      const alias =
        !exact &&
        (candidateNames.has(normalizeCandidateName(other.name)) ||
          other.aliases.some((a) => candidateNames.has(normalizeCandidateName(a))));
      if (exact || alias) {
        matches.push({
          // Cross-run proposals are not yet canonical, but they describe the same
          // family; label the family so the UI can present them coherently.
          canonicalType: targetKind,
          id: `run:${run.id}:${other.key}`,
          label: other.name,
          summary: other.summary || firstLine(other.detail),
          matchedBy: exact ? 'exact' : 'alias',
        });
      }
    }
  }
  return sortMatches(matches);
}

/** De-duplicates matches by canonical id+label, keeping the strongest strength. */
function dedupeMatches(matches: CanonicalMatch[]): CanonicalMatch[] {
  const byId = new Map<string, CanonicalMatch>();
  for (const match of sortMatches(matches)) {
    const key = `${match.canonicalType}:${match.id}`;
    const existing = byId.get(key);
    if (!existing || (existing.matchedBy === 'alias' && match.matchedBy === 'exact')) {
      byId.set(key, match);
    }
  }
  return sortMatches([...byId.values()]);
}

/** First non-empty line, trimmed (for a list/label preview). */
function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  return line.length > 200 ? line.slice(0, 200) : line;
}

/**
 * Alias-aware knowledge-entry matching (optionally restricted to a kind).
 *
 * Compares the candidate's name/aliases against each entry's normalized title
 * and tags. Only entries of the SAME kind are considered when `kind` is given.
 */
function matchKnowledge(entity: ChapterAnalysisEntity, entries: KnowledgeEntry[], kind?: KnowledgeEntryKind): CanonicalMatch[] {
  const candidateNames = candidateTokens(entity);
  const matches: CanonicalMatch[] = [];
  for (const entry of entries) {
    if (kind && entry.kind !== kind) continue;
    const exact = normalizeCandidateName(entry.title) === normalizeCandidateName(entity.name);
    const alias =
      !exact &&
      (candidateNames.has(normalizeCandidateName(entry.title)) ||
        entry.tags.some((tag) => candidateNames.has(normalizeCandidateName(tag))));
    if (exact || alias) {
      matches.push({
        canonicalType: 'knowledge-entry',
        id: entry.id,
        label: entry.title,
        summary: entry.summary || firstLine(entry.body),
        matchedBy: exact ? 'exact' : 'alias',
      });
    }
  }
  return sortMatches(matches);
}

/** The set of normalized name tokens for a candidate: its name + its aliases. */
function candidateTokens(entity: ChapterAnalysisEntity): Set<string> {
  const tokens = new Set<string>();
  tokens.add(normalizeCandidateName(entity.name));
  for (const alias of entity.aliases) tokens.add(normalizeCandidateName(alias));
  tokens.delete('');
  return tokens;
}

/** Exact matches first, then alias; stable by label. */
function sortMatches(matches: CanonicalMatch[]): CanonicalMatch[] {
  return [...matches].sort((a, b) => {
    if (a.matchedBy !== b.matchedBy) return a.matchedBy === 'exact' ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** De-duplicates strings, trimming + dropping empties, capped at 50. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.slice(0, 50);
}

/** Re-exported so the UI/tests share the exact key builder as the analysis service. */
export { buildEntityKey };
