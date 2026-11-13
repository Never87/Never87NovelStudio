import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createContinuityFactId } from '@/utils/id';
import type {
  ContinuityFact,
  ContinuityPredicate,
  ContinuitySubjectType,
  Evidence,
  LiveRankLookup,
  ReconstructedStateValue,
} from '@/types';
import { reconstructState } from '@/schemas/continuity';
import { ContinuityRepository } from '@/repositories/continuity-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';

/** Fields a caller may set when recording a continuity fact. */
export interface CreateContinuityFactInput {
  subjectType: ContinuitySubjectType;
  subjectId?: string | null;
  subjectLabel?: string;
  predicate: ContinuityPredicate;
  value: string;
  relatedLabel?: string;
  anchorChapterId: string;
  anchorSceneId?: string | null;
  evidence?: Evidence[];
}

/** Fields a caller may change on a fact. Anchor/identity changes are supported. */
export interface UpdateContinuityFactInput {
  subjectType?: ContinuitySubjectType;
  subjectId?: string | null;
  subjectLabel?: string;
  predicate?: ContinuityPredicate;
  value?: string;
  relatedLabel?: string;
  anchorChapterId?: string;
  anchorSceneId?: string | null;
  evidence?: Evidence[];
}

/** One reconstructed state value plus its human labels for display. */
export interface SubjectState {
  subjectType: ContinuitySubjectType;
  subjectId: string | null;
  subjectLabel: string;
  values: ReconstructedStateValue[];
}

/**
 * Business layer for continuity (P7).
 *
 * Implements the EVENT-SOURCED model: facts are appended; state is a deterministic
 * FOLD computed on demand. There are no mutable per-character snapshots — the
 * `ContinuityFact` list is the single source of truth.
 *
 * ## Ordering & reordering
 *
 * Facts are anchored to a chapter (and optionally a scene). The Service derives a
 * LIVE `LiveRankLookup` from the current outline (chapter order across volumes,
 * then scene order within a chapter) and passes it to the pure `reconstructState`
 * fold, so:
 *   - multiple facts anchored to the same chapter/scene are ordered by
 *     scene rank → recordedAt → id (stable, deterministic tie-breaks);
 *   - REORDERING chapters/scenes cannot silently corrupt reconstruction, because
 *     state is never read from a stored snapshot — it is recomputed against the
 *     live order every time.
 *
 * A cached `anchorRank` is still persisted (best effort) so a project displayed
 * without an outline can order facts; it is refreshed whenever facts are written
 * while an outline is available.
 */
export class ContinuityService {
  private readonly repository: ContinuityRepository;
  private readonly outlineService: OutlineService;
  private readonly sceneService: SceneService;

  constructor(deps: {
    repository?: ContinuityRepository;
    outlineService?: OutlineService;
    sceneService?: SceneService;
  } = {}) {
    this.repository = deps.repository ?? new ContinuityRepository();
    this.outlineService = deps.outlineService ?? new OutlineService();
    this.sceneService = deps.sceneService ?? new SceneService();
  }

  /* -------------------------------- CRUD --------------------------------- */

  async listFacts(projectId: string): Promise<ContinuityFact[]> {
    try {
      return await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list continuity facts of project "${projectId}"`);
    }
  }

  /**
   * Records a new fact. Rejects a fact whose chapter does not belong to the
   * project, and derives its cached `anchorRank` from the current outline.
   */
  async createFact(projectId: string, input: CreateContinuityFactInput): Promise<ContinuityFact> {
    const rankLookup = await this.buildLiveRankLookup(projectId);
    if (!rankLookup.chapterRank.has(input.anchorChapterId)) {
      throw new ProjectServiceError(
        `Chapter "${input.anchorChapterId}" is not part of project "${projectId}".`,
      );
    }
    if (input.anchorSceneId) {
      const sceneValid = await this.assertSceneInChapter(input.anchorChapterId, input.anchorSceneId);
      if (!sceneValid) {
        throw new ProjectServiceError(`Scene "${input.anchorSceneId}" is not part of chapter "${input.anchorChapterId}".`);
      }
    }

    const timestamp = now();
    const fact: ContinuityFact = {
      id: createContinuityFactId(),
      projectId,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      subjectLabel: input.subjectLabel ?? '',
      predicate: input.predicate,
      value: input.value,
      relatedLabel: input.relatedLabel ?? '',
      anchorChapterId: input.anchorChapterId,
      anchorSceneId: input.anchorSceneId ?? null,
      anchorRank: rankLookup.chapterRank.get(input.anchorChapterId) ?? 0,
      evidence: input.evidence ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      return await this.repository.create(fact);
    } catch (error) {
      throw this.wrap(error, `Failed to record a continuity fact for project "${projectId}"`);
    }
  }

  async updateFact(projectId: string, id: string, input: UpdateContinuityFactInput): Promise<ContinuityFact> {
    const existing = await this.requireFact(projectId, id);
    const rankLookup = await this.buildLiveRankLookup(projectId);

    const anchorChapterId = input.anchorChapterId ?? existing.anchorChapterId;
    if (!rankLookup.chapterRank.has(anchorChapterId)) {
      throw new ProjectServiceError(`Chapter "${anchorChapterId}" is not part of project "${projectId}".`);
    }

    const merged: ContinuityFact = {
      ...existing,
      ...(input.subjectType !== undefined ? { subjectType: input.subjectType } : {}),
      ...(input.subjectLabel !== undefined ? { subjectLabel: input.subjectLabel } : {}),
      ...(input.predicate !== undefined ? { predicate: input.predicate } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.relatedLabel !== undefined ? { relatedLabel: input.relatedLabel } : {}),
      ...(input.anchorChapterId !== undefined ? { anchorChapterId } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      anchorRank: rankLookup.chapterRank.get(anchorChapterId) ?? existing.anchorRank,
      updatedAt: now(),
    };

    if (input.subjectId !== undefined) merged.subjectId = input.subjectId;
    if (input.anchorSceneId !== undefined) merged.anchorSceneId = input.anchorSceneId;

    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update continuity fact "${id}"`);
    }
  }

  async deleteFact(projectId: string, id: string): Promise<void> {
    await this.requireFact(projectId, id);
    try {
      await this.repository.delete(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete continuity fact "${id}"`);
    }
  }

  async deleteFactsOfProject(projectId: string): Promise<number> {
    try {
      return await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete continuity facts of project "${projectId}"`);
    }
  }

  /* ------------------------------- Querying ------------------------------ */

  /**
   * Reconstructs each subject's state AFTER all facts (i.e. the latest state).
   * Deterministic regardless of input order; see the class docs for tie-breaks.
   */
  async currentState(projectId: string): Promise<SubjectState[]> {
    const facts = await this.listFacts(projectId);
    const rankLookup = await this.buildLiveRankLookup(projectId);
    const visible = this.withoutOrphanedAnchors(facts, rankLookup);
    const state = reconstructState(visible, { liveRank: rankLookup });
    return this.groupBySubject(visible, state);
  }

  /**
   * Reconstructs state AS OF a chapter: includes facts anchored at or before the
   * given chapter (inclusive of that chapter and all its scenes), in live story
   * order, excluding any fact anchored later. This is the "what was true up to
   * and including chapter N" view used to answer point-in-time questions.
   *
   * If the chapter is unknown to the project, an error is thrown rather than
   * silently returning everything.
   */
  async stateAsOf(projectId: string, chapterId: string): Promise<SubjectState[]> {
    const facts = await this.listFacts(projectId);
    const rankLookup = await this.buildLiveRankLookup(projectId);
    const stopRank = rankLookup.chapterRank.get(chapterId);
    if (stopRank === undefined) {
      throw new ProjectServiceError(`Chapter "${chapterId}" is not part of project "${projectId}".`);
    }
    const visible = this.withoutOrphanedAnchors(facts, rankLookup);
    const state = reconstructState(visible, { stopRank, liveRank: rankLookup });
    return this.groupBySubject(visible, state);
  }

  /**
   * Builds a `LiveRankLookup` from the CURRENT outline.
   *
   * Chapters are ranked across volumes in volume order then chapter order
   * (a global story order). Scenes are ranked within their chapter by scene
   * order. Reordering a chapter/scene therefore changes the ranks used by the
   * next reconstruction, which is exactly what keeps point-in-time state correct.
   */
  async buildLiveRankLookup(projectId: string): Promise<{ chapterRank: Map<string, number>; sceneRank: Map<string, number> }> {
    const chapterRank = new Map<string, number>();
    const sceneRank = new Map<string, number>();
    try {
      const outline = await this.outlineService.getOutline(projectId);
      let rank = 0;
      for (const { chapters } of outline) {
        for (const chapter of chapters) {
          chapterRank.set(chapter.id, rank);
          rank += 1;
          const scenes = await this.sceneService.listScenes(chapter.id);
          scenes.forEach((scene, index) => sceneRank.set(scene.id, index));
        }
      }
    } catch (error) {
      // A missing/unreadable outline is not fatal: facts still order by their
      // cached anchorRank. We surface nothing here — reconstruction degrades
      // gracefully rather than blocking the whole continuity view.
      void error;
    }
    return { chapterRank, sceneRank };
  }

  /**
   * Drops facts whose anchor chapter no longer exists in the live outline.
   *
   * A fact is anchored to a specific chapter; if that chapter is deleted, the
   * fact's anchor is orphaned and it must NOT silently keep contributing to the
   * reconstructed state (it would otherwise persist as a phantom "current"
   * value because reconstruction folds all facts and only uses live ranks for
   * ORDERING, not existence). We only apply this filter when a live outline is
   * actually available (`chapterRank` non-empty); when there is no readable
   * outline we fall back to the cached ranks rather than hide every fact.
   *
   * This keeps the fact rows intact (they are the event log) — it only excludes
   * orphaned anchors from the reconstructed VIEW.
   */
  private withoutOrphanedAnchors(
    facts: ContinuityFact[],
    rankLookup: { chapterRank: Map<string, number>; sceneRank: Map<string, number> },
  ): ContinuityFact[] {
    if (rankLookup.chapterRank.size === 0) return facts;
    return facts.filter((fact) => rankLookup.chapterRank.has(fact.anchorChapterId));
  }

  /* ------------------------------- helpers ------------------------------- */

  private async groupBySubject(
    facts: ContinuityFact[],
    state: Map<string, ReconstructedStateValue>,
  ): Promise<SubjectState[]> {
    // Index subjects for stable display order + preferred labels.
    const subjectMeta = new Map<string, { subjectType: ContinuitySubjectType; subjectId: string | null; subjectLabel: string; firstRank: number }>();
    for (const fact of facts) {
      const key = fact.subjectId ?? `label:${fact.subjectLabel.toLowerCase()}`;
      const composite = `${fact.subjectType}:${key}`;
      if (!subjectMeta.has(composite)) {
        subjectMeta.set(composite, {
          subjectType: fact.subjectType,
          subjectId: fact.subjectId,
          subjectLabel: fact.subjectLabel,
          firstRank: fact.anchorRank,
        });
      } else if (fact.subjectLabel && !subjectMeta.get(composite)!.subjectLabel) {
        subjectMeta.get(composite)!.subjectLabel = fact.subjectLabel;
      }
    }

    const bySubject = new Map<string, SubjectState & { firstRank: number }>();
    for (const value of state.values()) {
      const fact = value.fact;
      const key = fact.subjectId ?? `label:${fact.subjectLabel.toLowerCase()}`;
      const composite = `${fact.subjectType}:${key}`;
      const meta = subjectMeta.get(composite)!;
      const existing = bySubject.get(composite);
      if (existing) {
        existing.values.push(value);
      } else {
        bySubject.set(composite, {
          subjectType: meta.subjectType,
          subjectId: meta.subjectId,
          subjectLabel: meta.subjectLabel,
          values: [value],
          firstRank: meta.firstRank,
        });
      }
    }

    const subjects = [...bySubject.values()];
    for (const subject of subjects) {
      subject.values.sort((a, b) => a.predicate.localeCompare(b.predicate));
    }
    return subjects
      .sort((a, b) => {
        if (a.firstRank !== b.firstRank) return a.firstRank - b.firstRank;
        return a.subjectLabel.localeCompare(b.subjectLabel, undefined, { sensitivity: 'base' });
      })
      .map(({ firstRank, ...rest }) => {
        void firstRank;
        return rest;
      });
  }

  private async requireFact(projectId: string, id: string): Promise<ContinuityFact> {
    const fact = await this.repository.getById(id);
    if (!fact || fact.projectId !== projectId) {
      throw new ProjectServiceError(`Continuity fact "${id}" was not found in project "${projectId}"`);
    }
    return fact;
  }

  private async assertSceneInChapter(chapterId: string, sceneId: string): Promise<boolean> {
    const scenes = await this.sceneService.listScenes(chapterId);
    return scenes.some((scene) => scene.id === sceneId);
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectRepositoryError) return error;
    if (error instanceof ProjectServiceError) return error;
    if (error instanceof ZodError) {
      return new ProjectValidationError(message, error.issues, error);
    }
    return new ProjectServiceError(message, error);
  }
}

export type { ReconstructedStateValue, LiveRankLookup };
