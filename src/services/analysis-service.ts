import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createAnalysisFindingId } from '@/utils/id';
import type {
  AnalysisCategory,
  AnalysisFinding,
  AnalysisOrigin,
  AnalysisSeverity,
  AnalysisStatus,
  ContinuityFact,
  Evidence,
  KnowledgeEntry,
} from '@/types';
import { compareFacts } from '@/schemas/continuity';
import { AnalysisRepository } from '@/repositories/analysis-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';
import { ContinuityService } from './continuity-service';
import { KnowledgeService } from './knowledge-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';

/** A candidate finding produced by a detector, before persistence. */
export interface FindingDraft {
  category: AnalysisCategory;
  severity: AnalysisSeverity;
  origin: AnalysisOrigin;
  title: string;
  description: string;
  evidence: Evidence[];
  relatedFactIds?: string[];
  relatedEntryIds?: string[];
}

/** Result of a deterministic analysis run. */
export interface RunAnalysisResult {
  /** New findings that were persisted (all evidence-backed). */
  created: AnalysisFinding[];
  /** Drafts that were skipped because they could not cite valid evidence. */
  skippedNoEvidence: number;
}

/** Fields a caller may change when reviewing a finding. */
export interface UpdateFindingInput {
  status?: AnalysisStatus;
  severity?: AnalysisSeverity;
  title?: string;
  description?: string;
}

/**
 * Business layer for story analysis (P7).
 *
 * ## Deterministic-first
 *
 * `runDeterministic` examines continuity facts + knowledge entries and emits
 * findings from a set of built-in detectors. Every emitted finding carries at
 * least one valid `Evidence` (chapter/scene locator). A candidate that cannot be
 * tied to a location is SKIPPED and counted — never persisted without evidence.
 *
 * ## AI-assisted suggestions — NOT implemented in P7 (reserved)
 *
 * The P7 detectors above are 100% deterministic. An OPTIONAL AI-assisted path was
 * specified but is NOT shipped in this phase: there is no `analyzeWithAi` method
 * and no UI trigger. If/when it is added it MUST (a) be explicitly user-triggered
 * (no background scans), (b) reuse the P5 `AiAssistanceService` pipeline (no second
 * execution engine), (c) land as DRAFT findings the user reviews — never
 * auto-applied, and (d) still require valid evidence to be saved (enforced by
 * `saveDraft` + the schema `evidence.min(1)`). `saveDraft` is the single, reviewed
 * entry point that any future AI path would go through, so those guarantees hold.
 *
 * ## Findings are data, never manuscript edits
 *
 * Persisting a finding never touches chapters/scenes. It records an issue + its
 * evidence for the user to act on.
 */
export class AnalysisService {
  private readonly repository: AnalysisRepository;
  private readonly continuityService: ContinuityService;
  private readonly knowledgeService: KnowledgeService;
  private readonly outlineService: OutlineService;
  private readonly sceneService: SceneService;

  constructor(deps: {
    repository?: AnalysisRepository;
    continuityService?: ContinuityService;
    knowledgeService?: KnowledgeService;
    outlineService?: OutlineService;
    sceneService?: SceneService;
  } = {}) {
    this.repository = deps.repository ?? new AnalysisRepository();
    this.continuityService = deps.continuityService ?? new ContinuityService();
    this.knowledgeService = deps.knowledgeService ?? new KnowledgeService();
    this.outlineService = deps.outlineService ?? new OutlineService();
    this.sceneService = deps.sceneService ?? new SceneService();
  }

  /* ------------------------------- Reads --------------------------------- */

  async listFindings(projectId: string): Promise<AnalysisFinding[]> {
    try {
      return await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list analysis findings of project "${projectId}"`);
    }
  }

  /**
   * Persists a finding draft. Throws when the draft has no valid evidence — the
   * schema-level `min(1)` also enforces this, but we fail fast with a clear
   * message before hitting the DB.
   */
  async saveDraft(projectId: string, draft: FindingDraft): Promise<AnalysisFinding> {
    if (!hasValidEvidence(draft.evidence)) {
      throw new ProjectServiceError('A finding must cite at least one valid evidence location (chapter or scene).');
    }
    await this.assertEvidenceInProject(projectId, draft.evidence);
    const timestamp = now();
    const finding: AnalysisFinding = {
      id: createAnalysisFindingId(),
      projectId,
      category: draft.category,
      severity: draft.severity,
      status: 'open',
      origin: draft.origin,
      title: draft.title,
      description: draft.description,
      evidence: draft.evidence,
      relatedFactIds: draft.relatedFactIds ?? [],
      relatedEntryIds: draft.relatedEntryIds ?? [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      return await this.repository.create(finding);
    } catch (error) {
      throw this.wrap(error, `Failed to save analysis finding "${draft.title}"`);
    }
  }

  /** Updates the review fields of a finding. */
  async updateFinding(projectId: string, id: string, input: UpdateFindingInput): Promise<AnalysisFinding> {
    const existing = await this.requireFinding(projectId, id);
    const merged: AnalysisFinding = {
      ...existing,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: now(),
    };
    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update analysis finding "${id}"`);
    }
  }

  async deleteFinding(projectId: string, id: string): Promise<void> {
    await this.requireFinding(projectId, id);
    try {
      await this.repository.delete(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete analysis finding "${id}"`);
    }
  }

  async deleteFindingsOfProject(projectId: string): Promise<number> {
    try {
      return await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete analysis findings of project "${projectId}"`);
    }
  }

  /* --------------------------- Deterministic run ------------------------- */

  /**
   * Runs the built-in detectors and persists any evidence-backed findings.
   *
   * Detectors (all operate purely on stored data):
   *   1. same-chapter contradiction — one subject+predicate asserted two
   *      different values at the SAME anchor;
   *   2. actions after death — a `status: deceased` fact precedes a later
   *      `position`/`relationship`/`knowledge` fact for the same subject;
   *   3. unresolved foreshadowing — a knowledge entry tagged `foreshadowing`
   *      with no later `payoff` entry and no resolving finding.
   *
   * The run is idempotent-ish: it does not delete previously reviewed findings;
   * it appends new open findings. Callers typically review and dismiss.
   */
  async runDeterministic(projectId: string): Promise<RunAnalysisResult> {
    const [allFacts, entries, rankLookup] = await Promise.all([
      this.continuityService.listFacts(projectId),
      this.knowledgeService.listEntries(projectId),
      this.continuityService.buildLiveRankLookup(projectId),
    ]);

    // Ignore facts whose anchor chapter no longer exists in the live outline:
    // their evidence would point at a missing chapter (rejected by saveDraft),
    // and they are already excluded from the reconstructed view. Only filter when
    // a live outline is available (chapterRank non-empty).
    const facts = rankLookup.chapterRank.size === 0
      ? allFacts
      : allFacts.filter((fact) => rankLookup.chapterRank.has(fact.anchorChapterId));

    const drafts: FindingDraft[] = [];
    let skippedNoEvidence = 0;

    const push = (draft: FindingDraft) => {
      if (!hasValidEvidence(draft.evidence)) {
        skippedNoEvidence += 1;
        return;
      }
      drafts.push(draft);
    };

    this.detectSameChapterContradictions(facts, push);
    this.detectActionsAfterDeath(facts, rankLookup, push);
    this.detectUnresolvedForeshadowing(entries, push);

    const created: AnalysisFinding[] = [];
    for (const draft of drafts) {
      try {
        created.push(await this.saveDraft(projectId, draft));
      } catch (error) {
        // A draft that fails the project-scope evidence check (e.g. it cites a
        // chapter deleted since the fact/entry was recorded) is skipped rather
        // than aborting the whole run — reported via the skipped counter.
        if (error instanceof ProjectServiceError && /not part of (project|chapter)/i.test(error.message)) {
          skippedNoEvidence += 1;
          continue;
        }
        throw error;
      }
    }
    return { created, skippedNoEvidence };
  }

  /* ------------------------------- Detectors ----------------------------- */

  private detectSameChapterContradictions(facts: ContinuityFact[], push: (draft: FindingDraft) => void): void {
    // Group by subject+predicate+chapter, then look for divergent values.
    const groups = new Map<string, ContinuityFact[]>();
    for (const fact of facts) {
      const subject = fact.subjectId ?? `label:${fact.subjectLabel.toLowerCase()}`;
      const key = `${fact.subjectType}:${subject}:${fact.predicate}:${fact.anchorChapterId}:${fact.anchorSceneId ?? ''}`;
      const list = groups.get(key);
      if (list) list.push(fact);
      else groups.set(key, [fact]);
    }

    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const values = new Set(list.map((f) => f.value.trim().toLowerCase()));
      if (values.size < 2) continue;
      const first = list[0];
      const evidence = collectEvidence(list);
      push({
        category: 'continuity',
        severity: 'error',
        origin: 'deterministic',
        title: `Conflicting ${first.predicate} in the same location`,
        description:
          `"${subjectLabel(first)}" is recorded with conflicting ${first.predicate} values at the same point: ` +
          list.map((f) => `"${f.value}"`).join(' vs. ') +
          '. One of these facts is likely wrong.',
        evidence,
        relatedFactIds: list.map((f) => f.id),
      });
    }
  }

  private detectActionsAfterDeath(
    facts: ContinuityFact[],
    rankLookup: { chapterRank: Map<string, number>; sceneRank: Map<string, number> },
    push: (draft: FindingDraft) => void,
  ): void {
    const bySubject = new Map<string, ContinuityFact[]>();
    for (const fact of facts) {
      const subject = fact.subjectId ?? `label:${fact.subjectLabel.toLowerCase()}`;
      const key = `${fact.subjectType}:${subject}`;
      const list = bySubject.get(key);
      if (list) list.push(fact);
      else bySubject.set(key, [fact]);
    }

    for (const list of bySubject.values()) {
      const ordered = [...list].sort((a, b) => compareFacts(a, b, rankLookup));
      let deathFact: ContinuityFact | null = null;
      for (const fact of ordered) {
        if (fact.predicate === 'status' && /dead|deceased|killed|died/i.test(fact.value)) {
          deathFact = fact;
          continue;
        }
        if (deathFact && ['position', 'relationship', 'knowledge', 'possession'].includes(fact.predicate)) {
          const evidence = collectEvidence([deathFact, fact]);
          if (evidence.length === 0) continue;
          push({
            category: 'logic',
            severity: 'error',
            origin: 'deterministic',
            title: `"${subjectLabel(fact)}" acts after being marked dead`,
            description:
              `"${subjectLabel(fact)}" is recorded as "${deathFact.value}" but later has a ` +
              `${fact.predicate} fact ("${fact.value}"). Characters cannot act after death unless resurrected — ` +
              'verify the timeline or the death.',
            evidence,
            relatedFactIds: [deathFact.id, fact.id],
          });
          // Report once per subject to avoid a cascade of duplicates.
          break;
        }
      }
    }
  }

  private detectUnresolvedForeshadowing(entries: KnowledgeEntry[], push: (draft: FindingDraft) => void): void {
    const foreshadowing = entries.filter((entry) => entry.tags.some((tag) => /foreshadowing/i.test(tag)));
    if (foreshadowing.length === 0) return;
    const payoffs = entries.filter((entry) => entry.tags.some((tag) => /payoff|reveal|resolution/i.test(tag)));

    for (const seed of foreshadowing) {
      // A payoff exists if any other entry's searchText references this seed's title.
      const seedWord = seed.title.trim().toLowerCase();
      const hasPayoff = payoffs.some((p) => p.id !== seed.id && p.searchText.includes(seedWord));
      if (hasPayoff) continue;

      push({
        category: 'foreshadowing',
        severity: 'warning',
        origin: 'deterministic',
        title: `Unresolved foreshadowing: "${seed.title}"`,
        description:
          `The foreshadowing "${seed.title}" has no recorded payoff. If this seed is intentional, add a ` +
          'payoff entry (tagged "payoff" or "reveal") that references it.',
        evidence: seed.evidence,
        relatedEntryIds: [seed.id],
      });
    }
  }

  /* ------------------------------- helpers ------------------------------- */

  /**
   * Rejects evidence that points at a chapter/scene from ANOTHER project.
   *
   * Evidence must be project-scoped: a finding saved under project A may not cite
   * a chapter/scene belonging to project B (which would be a misleading, dangling
   * locator). We resolve the project's chapters once and check each locator:
   *   - a `chapterId` must be one of the project's chapters;
   *   - a `sceneId` (with or without a chapterId) must belong to a chapter of the
   *     project.
   * Evidence with only ids we can resolve pass; evidence whose locator is not
   * found in the project is rejected rather than silently stored.
   */
  private async assertEvidenceInProject(projectId: string, evidence: Evidence[]): Promise<void> {
    const chapters = await this.outlineService.listProjectChapters(projectId);
    const chapterIds = new Set(chapters.map((chapter) => chapter.id));
    const sceneCache = new Map<string, Set<string>>();
    const scenesOfChapter = async (chapterId: string): Promise<Set<string>> => {
      const cached = sceneCache.get(chapterId);
      if (cached) return cached;
      const scenes = await this.sceneService.listScenes(chapterId);
      const ids = new Set(scenes.map((scene) => scene.id));
      sceneCache.set(chapterId, ids);
      return ids;
    };

    for (const item of evidence) {
      if (item.chapterId) {
        if (!chapterIds.has(item.chapterId)) {
          throw new ProjectServiceError(
            `Evidence references chapter "${item.chapterId}", which is not part of project "${projectId}".`,
          );
        }
        if (item.sceneId) {
          const sceneIds = await scenesOfChapter(item.chapterId);
          if (!sceneIds.has(item.sceneId)) {
            throw new ProjectServiceError(
              `Evidence references scene "${item.sceneId}", which is not part of chapter "${item.chapterId}".`,
            );
          }
        }
        continue;
      }
      // Scene-only locator: the scene must live in some chapter of the project.
      if (item.sceneId) {
        let found = false;
        for (const chapterId of chapterIds) {
          const sceneIds = await scenesOfChapter(chapterId);
          if (sceneIds.has(item.sceneId)) {
            found = true;
            break;
          }
        }
        if (!found) {
          throw new ProjectServiceError(
            `Evidence references scene "${item.sceneId}", which is not part of project "${projectId}".`,
          );
        }
      }
    }
  }

  private async requireFinding(projectId: string, id: string): Promise<AnalysisFinding> {
    const finding = await this.repository.getById(id);
    if (!finding || finding.projectId !== projectId) {
      throw new ProjectServiceError(`Analysis finding "${id}" was not found in project "${projectId}"`);
    }
    return finding;
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

/** True when at least one evidence entry has a chapter or scene locator. */
function hasValidEvidence(evidence: Evidence[]): boolean {
  return evidence.some((item) => Boolean(item.chapterId) || Boolean(item.sceneId));
}

/**
 * Builds evidence from a fact's own evidence when present; otherwise falls back
 * to the fact's anchor chapter (a valid locator). De-dupes by locator.
 */
function collectEvidence(facts: ContinuityFact[]): Evidence[] {
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const fact of facts) {
    const source = fact.evidence.length > 0
      ? fact.evidence
      : [{ chapterId: fact.anchorChapterId, sceneId: fact.anchorSceneId, quote: fact.value, offset: null, note: '' }];
    for (const ev of source) {
      if (!ev.chapterId && !ev.sceneId) continue;
      const key = `${ev.chapterId ?? ''}:${ev.sceneId ?? ''}:${ev.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
  }
  return out;
}

function subjectLabel(fact: ContinuityFact): string {
  return fact.subjectLabel || fact.subjectId || 'a subject';
}
