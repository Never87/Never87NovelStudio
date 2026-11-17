import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createChapterAnalysisRunId } from '@/utils/id';
import { hashRawText } from '@/utils/text-hash';
import type {
  Chapter,
  ChapterAnalysisEntity,
  ChapterAnalysisRelationship,
  ChapterAnalysisRun,
} from '@/types';
import { ChapterAnalysisRunSchema } from '@/schemas/chapter-analysis';
import { ChapterAnalysisRepository } from '@/repositories/chapter-analysis-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';
import type { GenerateOptions, ResolvedAiTarget } from './ai-service';
import {
  buildChapterAnalysisMessages,
  parseAnalysisResponse,
  toCandidateEntity,
  toCandidateRelationship,
  ChapterAnalysisParseError,
} from './chapter-analysis/prompt';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Base class for chapter-analysis business errors. */
export class ChapterAnalysisServiceError extends ProjectServiceError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'ChapterAnalysisServiceError';
  }
}

/** The chapter or a run was not found within the requested project. */
export class ChapterAnalysisNotFoundError extends ChapterAnalysisServiceError {
  constructor(id: string, what: 'chapter' | 'run' = 'run') {
    super(`${what === 'chapter' ? 'Chapter' : 'Chapter analysis'} "${id}" was not found`);
    this.name = 'ChapterAnalysisNotFoundError';
  }
}

/**
 * A validation/consistency rule blocked the operation. Carries a machine-readable
 * `reason` so callers and tests can assert on the specific failure without
 * string-matching messages.
 */
export class ChapterAnalysisValidationError extends ChapterAnalysisServiceError {
  readonly reason: 'empty-prose' | 'invalid-ai-output' | 'invalid-candidate' | 'not-in-run';

  constructor(reason: ChapterAnalysisValidationError['reason'], message: string) {
    super(message);
    this.name = 'ChapterAnalysisValidationError';
    this.reason = reason;
  }
}

/* -------------------------------------------------------------------------- */
/* Public input/output shapes                                                 */
/* -------------------------------------------------------------------------- */

/** A generator matching `AiService.generate`'s signature (injectable for tests). */
export type AnalysisGenerateFn = (options: GenerateOptions) => Promise<{
  result: { content: string; usage?: unknown; finishReason?: string };
  target: ResolvedAiTarget;
}>;

/** Options for an analysis run. */
export interface AnalyzeChapterInput {
  /** Explicit model id; when omitted the task/global fallback chain is used. */
  modelId?: string;
  /** Optional free-form focus (e.g. "characters only"). */
  instruction?: string;
  /** Caller cancellation. */
  signal?: AbortSignal;
  /**
   * When true (default) and a run already exists for the current content
   * fingerprint, the existing run is returned unchanged (IDEMPOTENT). Pass
   * `false` to always request a fresh run even for unchanged prose.
   */
  reuseExisting?: boolean;
}

/** Result of an analysis run. */
export interface AnalyzeChapterResult {
  run: ChapterAnalysisRun;
  /** True when an existing (fingerprint-matching) run was returned unchanged. */
  reused: boolean;
  /** Model target that produced the candidates (null when reused / manual). */
  target: { providerName: string; modelName: string; modelId: string } | null;
}

/** Fields a caller may change on a candidate entity during review. */
export interface UpdateCandidateInput {
  name?: string;
  summary?: string;
  detail?: string;
  tags?: string[];
  status?: ChapterAnalysisEntity['status'];
  linkedEntityId?: string | null;
}

/** Fields a caller may change on a candidate relationship during review. */
export interface UpdateRelationshipInput {
  relation?: string;
  summary?: string;
  status?: ChapterAnalysisRelationship['status'];
  linkedFromEntityId?: string | null;
  linkedToEntityId?: string | null;
}

/**
 * Chapter Analysis service (P11).
 *
 * Runs the AI entity-extraction pass over ONE chapter's LIVE manuscript prose
 * and turns the result into reviewable candidate entities + relationships.
 *
 * ## Guarantees
 *
 *   - SAVE-FIRST / IDEMPOTENT: the chapter is read read-only (never mutated);
 *     a run is keyed by a `contentFingerprint` (sha256 of the prose), so
 *     re-analysing UNCHANGED prose returns the existing run instead of creating
 *     a duplicate. PROSE-CHANGED re-analysis produces a NEW run and KEEPS the old
 *     one as history.
 *   - STABLE-ID RELATIONSHIPS: candidates carry a stable `kind:normalizedName`
 *     key; relationships reference those keys (never array indices).
 *   - MANUAL-EDIT PROTECTION: once a candidate is reviewed (edited/accepted/
 *     dismissed) a later re-analysis NEVER overwrites it — the reviewed copy is
 *     carried forward into the new run and the fresh AI candidate of that key is
 *     dropped.
 *   - PROJECT-SCOPED: every read/write is scoped to `projectId`; this service
 *     never writes to any project entity (characters/chapters/…). Integration is
 *     a separate, user-driven concern.
 */
export class ChapterAnalysisService {
  private readonly repository: ChapterAnalysisRepository;
  private readonly generate: AnalysisGenerateFn;
  private readonly chapterLoader: (projectId: string, chapterId: string) => Promise<Chapter | null>;
  private readonly proseLoader: (projectId: string, chapterId: string) => Promise<string>;
  private readonly characterNames: (projectId: string) => Promise<string[]>;
  private readonly writeLocks = new Map<string, Promise<unknown>>();

  constructor(deps: {
    repository?: ChapterAnalysisRepository;
    generate?: AnalysisGenerateFn;
    /**
     * Loads a chapter, scoped to a project (returns null when absent/foreign).
     * Defaults to the OutlineService.
     */
    chapterLoader?: (projectId: string, chapterId: string) => Promise<Chapter | null>;
    /**
     * Loads a chapter's prose (read-only, side-effect free). Defaults to the
     * ManuscriptService.
     */
    proseLoader?: (projectId: string, chapterId: string) => Promise<string>;
    /** Lists existing character names to help the model stay consistent. */
    characterNames?: (projectId: string) => Promise<string[]>;
  } = {}) {
    this.repository = deps.repository ?? new ChapterAnalysisRepository();
    this.generate = deps.generate ?? defaultGenerate;
    this.chapterLoader = deps.chapterLoader ?? defaultChapterLoader;
    this.proseLoader = deps.proseLoader ?? defaultProseLoader;
    this.characterNames = deps.characterNames ?? defaultCharacterNames;
  }

  /* ------------------------------- Reads --------------------------------- */

  /** One run, scoped to `projectId` (null when absent/foreign). */
  async getRun(projectId: string, runId: string): Promise<ChapterAnalysisRun | null> {
    try {
      const run = await this.repository.getById(runId);
      if (!run || run.projectId !== projectId) return null;
      return run;
    } catch (error) {
      throw this.wrap(error, `Failed to load chapter analysis "${runId}"`);
    }
  }

  /** All runs of a project, newest first. */
  async listRuns(projectId: string): Promise<ChapterAnalysisRun[]> {
    try {
      return await this.repository.listByProject(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list chapter analyses of project "${projectId}"`);
    }
  }

  /**
   * The analysis history for one chapter, newest first. Includes the current
   * run at index 0 (when present) and every older run after it.
   */
  async getHistory(projectId: string, chapterId: string): Promise<ChapterAnalysisRun[]> {
    try {
      return await this.repository.listByChapter(projectId, chapterId);
    } catch (error) {
      throw this.wrap(error, `Failed to list chapter analysis history of chapter "${chapterId}"`);
    }
  }

  /**
   * The most recent run for one chapter, or null. Convenience for the UI's
   * default view.
   */
  async getLatestRun(projectId: string, chapterId: string): Promise<ChapterAnalysisRun | null> {
    const history = await this.getHistory(projectId, chapterId);
    return history[0] ?? null;
  }

  /* ------------------------------ Analysis ------------------------------- */

  /**
   * Analyses a chapter's prose via the AI pipeline and persists the (grounded)
   * candidates as a reviewable run.
   *
   * IDEMPOTENT per content fingerprint: if a run already exists for the current
   * fingerprint and `reuseExisting !== false`, that run is returned unchanged
   * (no second AI call, no duplicate). When the prose has changed since the last
   * run, a NEW run is produced and PREVIOUSLY-REVIEWED candidates are carried
   * forward so a re-analysis never silently discards the author's decisions.
   */
  async analyzeChapter(
    projectId: string,
    chapterId: string,
    input: AnalyzeChapterInput = {},
  ): Promise<AnalyzeChapterResult> {
    const chapter = await this.requireChapter(projectId, chapterId);
    const prose = (await this.proseLoader(projectId, chapterId)).trim();
    if (prose.length === 0) {
      throw new ChapterAnalysisValidationError(
        'empty-prose',
        'This chapter has no prose yet — write something before analysing it.',
      );
    }

    const contentFingerprint = hashRawText(prose);
    const reuseExisting = input.reuseExisting !== false;

    // IDEMPOTENT: return an unchanged run for the same fingerprint.
    if (reuseExisting) {
      const existing = await this.repository.findByFingerprint(projectId, chapterId, contentFingerprint);
      if (existing) {
        return { run: existing, reused: true, target: null };
      }
    }

    // Load prior history (carry forward reviewed candidates) and existing names.
    const [history, knownNames] = await Promise.all([
      this.getHistory(projectId, chapterId),
      this.characterNames(projectId).catch(() => [] as string[]),
    ]);
    const previousRun = history[0] ?? null;

    const messages = buildChapterAnalysisMessages({
      chapterTitle: chapter.title,
      prose,
      instruction: input.instruction,
      knownNames,
    });

    let generated: Awaited<ReturnType<AnalysisGenerateFn>>;
    try {
      generated = await this.generate({
        task: 'general-chat',
        messages,
        modelId: input.modelId,
        temperature: 0,
        signal: input.signal,
      });
    } catch (error) {
      throw this.wrap(error, `Chapter analysis failed for chapter "${chapterId}"`);
    }

    let parsed;
    try {
      parsed = parseAnalysisResponse(generated.result.content);
    } catch (error) {
      if (error instanceof ChapterAnalysisParseError) {
        throw new ChapterAnalysisValidationError('invalid-ai-output', error.message);
      }
      throw this.wrap(error, `Chapter analysis failed for chapter "${chapterId}"`);
    }

    // Make the new run strictly NEWER than the previous one, even when both are
    // produced within the same millisecond — "newest first" history ordering must
    // never depend on random id tie-breaks.
    const baseTs = now();
    const timestamp = previousRun ? Math.max(baseTs, previousRun.updatedAt + 1) : baseTs;
    const { entities, relationships } = this.mergeWithHistory(parsed, previousRun, prose);

    const run: ChapterAnalysisRun = {
      id: createChapterAnalysisRunId(),
      projectId,
      chapterId,
      contentFingerprint,
      origin: 'ai',
      modelTarget: {
        providerName: String(generated.target.provider.name),
        modelName: String(generated.target.model.displayName),
        modelId: String(generated.target.model.modelId),
      },
      entities,
      relationships,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.validateRun(run);

    // Fingerprint find→create inside ONE transaction so two concurrent runs of
    // the same unchanged prose cannot both insert a duplicate. When reuse is
    // disabled, the caller explicitly wants a fresh run, so the raced check is
    // skipped and duplicates for the same fingerprint are permitted (by design).
    const lockKey = `${projectId}::${chapterId}::${contentFingerprint}`;
    return this.withWriteLock(lockKey, () =>
      this.repository.runTransaction(async () => {
        if (reuseExisting) {
          const raced = await this.repository.findByFingerprint(projectId, chapterId, contentFingerprint);
          if (raced) {
            return { run: raced, reused: true, target: null } satisfies AnalyzeChapterResult;
          }
        }
        const created = await this.repository.create(run);
        return {
          run: created,
          reused: false,
          target: run.modelTarget,
        } satisfies AnalyzeChapterResult;
      }),
    );
  }

  /* ------------------------------- Review -------------------------------- */

  /**
   * Updates ONE candidate entity within a run (editorial fields + review status).
   * Marks the candidate `reviewed: true`, which PROTECTS it from being
   * overwritten by a later re-analysis. Relationship endpoint keys that depend on
   * the candidate's name are NOT auto-renamed (relationships anchor on the stable
   * key that existed at extraction time).
   */
  async updateCandidate(
    projectId: string,
    runId: string,
    entityKey: string,
    input: UpdateCandidateInput,
  ): Promise<ChapterAnalysisRun> {
    const run = await this.requireRun(projectId, runId);
    const index = run.entities.findIndex((entity) => entity.key === entityKey);
    if (index < 0) {
      throw new ChapterAnalysisValidationError('not-in-run', `Candidate "${entityKey}" is not part of run "${runId}".`);
    }

    const existing = run.entities[index];
    const next: ChapterAnalysisEntity = {
      ...existing,
      name: input.name !== undefined ? input.name : existing.name,
      summary: input.summary !== undefined ? input.summary : existing.summary,
      detail: input.detail !== undefined ? input.detail : existing.detail,
      tags: input.tags !== undefined ? input.tags : existing.tags,
      status: input.status !== undefined ? input.status : existing.status,
      linkedEntityId: input.linkedEntityId !== undefined ? input.linkedEntityId : existing.linkedEntityId,
      reviewed: true,
    };

    const entities = run.entities.slice();
    entities[index] = next;
    return this.persistUpdate(run, { entities });
  }

  /** Sets a candidate's review status (accept / dismiss / re-propose). */
  async setCandidateStatus(
    projectId: string,
    runId: string,
    entityKey: string,
    status: ChapterAnalysisEntity['status'],
  ): Promise<ChapterAnalysisRun> {
    return this.updateCandidate(projectId, runId, entityKey, { status });
  }

  /** Updates ONE relationship within a run (status/editorial), marking it reviewed. */
  async updateRelationship(
    projectId: string,
    runId: string,
    relationshipKey: string,
    input: UpdateRelationshipInput,
  ): Promise<ChapterAnalysisRun> {
    const run = await this.requireRun(projectId, runId);
    const index = run.relationships.findIndex((rel) => rel.key === relationshipKey);
    if (index < 0) {
      throw new ChapterAnalysisValidationError(
        'not-in-run',
        `Relationship "${relationshipKey}" is not part of run "${runId}".`,
      );
    }
    const existing = run.relationships[index];
    const next: ChapterAnalysisRelationship = {
      ...existing,
      relation: input.relation !== undefined ? input.relation : existing.relation,
      summary: input.summary !== undefined ? input.summary : existing.summary,
      status: input.status !== undefined ? input.status : existing.status,
      linkedFromEntityId:
        input.linkedFromEntityId !== undefined ? input.linkedFromEntityId : existing.linkedFromEntityId,
      linkedToEntityId: input.linkedToEntityId !== undefined ? input.linkedToEntityId : existing.linkedToEntityId,
      reviewed: true,
    };
    const relationships = run.relationships.slice();
    relationships[index] = next;
    return this.persistUpdate(run, { relationships });
  }

  /* ------------------------------ Deletion ------------------------------- */

  /** Deletes a run (history entry). Does NOT touch the chapter or its prose. */
  async deleteRun(projectId: string, runId: string): Promise<void> {
    await this.requireRun(projectId, runId);
    try {
      await this.repository.deleteById(runId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete chapter analysis "${runId}"`);
    }
  }

  /* ------------------------------ Internals ------------------------------ */

  /**
   * Merges freshly-parsed AI candidates with a previous run: any candidate the
   * author already REVIEWED (in the previous run) is carried forward verbatim
   * (preserving status/linkedEntityId/edits), and the fresh AI candidate with the
   * same key is dropped. Relationships are carried forward when BOTH endpoints
   * survive, and any relationship the author reviewed is preserved.
   */
  private mergeWithHistory(
    parsed: ReturnType<typeof parseAnalysisResponse>,
    previousRun: ChapterAnalysisRun | null,
    prose: string,
  ): { entities: ChapterAnalysisEntity[]; relationships: ChapterAnalysisRelationship[] } {
    const reviewedByKey = new Map<string, ChapterAnalysisEntity>();
    const reviewedRelByKey = new Map<string, ChapterAnalysisRelationship>();
    if (previousRun) {
      for (const entity of previousRun.entities) {
        if (entity.reviewed) reviewedByKey.set(entity.key, entity);
      }
      for (const rel of previousRun.relationships) {
        if (rel.reviewed) reviewedRelByKey.set(rel.key, rel);
      }
    }

    // Fresh, unreviewed candidates (skip any key the author already reviewed).
    const entities = parsed.entities
      .map((raw) => toCandidateEntity(raw, prose))
      .filter((entity) => !reviewedByKey.has(entity.key));

    // Carry reviewed candidates that are STILL relevant: keep them when the key
    // appears in the new run OR when they were accepted (accepted candidates are
    // the author's confirmed facts — never silently dropped). Dismissed
    // candidates are kept only if their key still appears in the new prose set.
    const newKeys = new Set(entities.map((entity) => entity.key));
    for (const [key, entity] of reviewedByKey) {
      if (entity.status === 'accepted' || newKeys.has(key)) {
        entities.push(entity);
        newKeys.add(key);
      }
    }

    const relationships: ChapterAnalysisRelationship[] = parsed.relationships
      .map((raw, index) => toCandidateRelationship(raw, index, prose))
      .filter((rel) => newKeys.has(rel.fromKey) && newKeys.has(rel.toKey) && !reviewedRelByKey.has(rel.key));

    // Carry forward reviewed relationships whose endpoints survive.
    const relKeys = new Set(relationships.map((rel) => rel.key));
    for (const [key, rel] of reviewedRelByKey) {
      if ((rel.status === 'accepted' || relKeys.has(key)) && newKeys.has(rel.fromKey) && newKeys.has(rel.toKey)) {
        relationships.push(rel);
        relKeys.add(key);
      }
    }

    return { entities, relationships };
  }

  /** Validates, stamps `updatedAt`, and persists a whole-run update. */
  private async persistUpdate(
    run: ChapterAnalysisRun,
    patch: Partial<Pick<ChapterAnalysisRun, 'entities' | 'relationships'>>,
  ): Promise<ChapterAnalysisRun> {
    const next: ChapterAnalysisRun = { ...run, ...patch, updatedAt: now() };
    this.validateRun(next);
    try {
      return await this.repository.update(next);
    } catch (error) {
      throw this.wrap(error, `Failed to update chapter analysis "${run.id}"`);
    }
  }

  /** Serialises writes per lock key (see `analyzeChapter`). */
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

  private async requireChapter(projectId: string, chapterId: string): Promise<Chapter> {
    const chapter = await this.chapterLoader(projectId, chapterId);
    if (!chapter || chapter.projectId !== projectId) {
      throw new ChapterAnalysisNotFoundError(chapterId, 'chapter');
    }
    return chapter;
  }

  private async requireRun(projectId: string, runId: string): Promise<ChapterAnalysisRun> {
    const run = await this.getRun(projectId, runId);
    if (!run) throw new ChapterAnalysisNotFoundError(runId, 'run');
    return run;
  }

  private validateRun(run: ChapterAnalysisRun): void {
    const result = ChapterAnalysisRunSchema.safeParse(run);
    if (!result.success) {
      throw new ChapterAnalysisValidationError(
        'invalid-candidate',
        `Chapter analysis is invalid: ${result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ChapterAnalysisServiceError) return error;
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) return new ProjectValidationError(message, error.issues, error);
    return new ChapterAnalysisServiceError(message, error);
  }
}

/* -------------------------------------------------------------------------- */
/* Default dependencies (lazily resolved to avoid eager singletons in tests)  */
/* -------------------------------------------------------------------------- */

/** Default AI executor: delegates to the shared P5 `aiService` singleton. */
async function defaultGenerate(options: GenerateOptions): Promise<{
  result: { content: string; usage?: unknown; finishReason?: string };
  target: ResolvedAiTarget;
}> {
  const { aiService } = await import('./index');
  const { result, target } = await aiService.generate(options);
  return { result, target };
}

async function defaultChapterLoader(projectId: string, chapterId: string): Promise<Chapter | null> {
  const { outlineService } = await import('./index');
  const chapter = await outlineService.getChapter(chapterId);
  if (!chapter || chapter.projectId !== projectId) return null;
  return chapter;
}

/** Reads a chapter's prose READ-ONLY (never creates a draft as a side effect). */
async function defaultProseLoader(projectId: string, chapterId: string): Promise<string> {
  const { manuscriptService } = await import('./index');
  const draft = await manuscriptService.getDraft('chapter', chapterId);
  if (!draft || draft.projectId !== projectId) return '';
  return draft.content;
}

async function defaultCharacterNames(projectId: string): Promise<string[]> {
  const { characterService } = await import('./index');
  const characters = await characterService.listCharacters(projectId);
  return characters.map((character) => character.name);
}
