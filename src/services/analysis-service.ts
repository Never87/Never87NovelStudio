import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createAnalysisFindingId } from '@/utils/id';
import type {
  AnalysisCategory,
  AnalysisFinding,
  AnalysisOrigin,
  AnalysisSeverity,
  AnalysisStatus,
  Chapter,
  Character,
  ContinuityFact,
  Evidence,
  KnowledgeEntry,
  Scene,
  World,
} from '@/types';
import { compareFacts } from '@/schemas/continuity';
import { AnalysisRepository } from '@/repositories/analysis-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';
import { ContinuityService } from './continuity-service';
import { KnowledgeService } from './knowledge-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';
import { CharacterService } from './character-service';
import { WorldService } from './world-service';

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
 * `runDeterministic` examines continuity facts + knowledge entries + structured
 * outline/scene/character/world data and emits findings from a set of built-in
 * detectors. Every emitted finding carries at least one valid `Evidence`
 * (chapter/scene locator). A candidate that cannot be tied to a location is
 * SKIPPED and counted — never persisted without evidence.
 *
 * ## Detector coverage (all six ANALYSIS_CATEGORIES)
 *
 *   - `continuity`  — same-chapter contradiction (one subject+predicate, two
 *                     values at the SAME anchor).
 *   - `logic`       — action after a `status: deceased` fact.
 *   - `foreshadowing` — unresolved foreshadowing entry.
 *   - `timeline`    — contradictory ordering: two scenes in one chapter share
 *                     the same `order` integer (ambiguous story position). Only
 *                     emitted when scene `order` is actually inconsistent; no
 *                     timestamps are invented.
 *   - `character`   — a character record whose `status` contradicts the latest
 *                     continuity `status` fact in story order, OR an `unused`
 *                     character that is nonetheless present in a scene. Only
 *                     structured status/scene-membership is compared — never
 *                     subjective personality text.
 *   - `world-rule`  — a hard prohibition stated in a rule-classified world
 *                     section (e.g. "X cannot …") contradicted by a knowledge
 *                     `rule` entry (or continuity fact) that permits the SAME
 *                     term ("X can …"). Only emitted when a concrete prohibition
 *                     term and a concrete contradicting source are both found.
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
 * Persisting a finding never touches chapters/scenes/characters/world. It records
 * an issue + its evidence for the user to act on.
 */
export class AnalysisService {
  private readonly repository: AnalysisRepository;
  private readonly continuityService: ContinuityService;
  private readonly knowledgeService: KnowledgeService;
  private readonly outlineService: OutlineService;
  private readonly sceneService: SceneService;
  private readonly characterService: CharacterService;
  private readonly worldService: WorldService;

  constructor(deps: {
    repository?: AnalysisRepository;
    continuityService?: ContinuityService;
    knowledgeService?: KnowledgeService;
    outlineService?: OutlineService;
    sceneService?: SceneService;
    characterService?: CharacterService;
    worldService?: WorldService;
  } = {}) {
    this.repository = deps.repository ?? new AnalysisRepository();
    this.continuityService = deps.continuityService ?? new ContinuityService();
    this.knowledgeService = deps.knowledgeService ?? new KnowledgeService();
    this.outlineService = deps.outlineService ?? new OutlineService();
    this.sceneService = deps.sceneService ?? new SceneService();
    this.characterService = deps.characterService ?? new CharacterService();
    this.worldService = deps.worldService ?? new WorldService();
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
   * Detectors (all operate purely on stored data; see class docs for the full
   * coverage table across all six categories). Each detector only emits when both
   * a concrete contradiction AND a valid chapter/scene locator can be produced.
   *
   * The run is idempotent-ish: it does not delete previously reviewed findings;
   * it appends new open findings. Callers typically review and dismiss.
   */
  async runDeterministic(projectId: string): Promise<RunAnalysisResult> {
    const [allFacts, entries, rankLookup, chapters, characters, world] = await Promise.all([
      this.continuityService.listFacts(projectId),
      this.knowledgeService.listEntries(projectId),
      this.continuityService.buildLiveRankLookup(projectId),
      this.outlineService.listProjectChapters(projectId),
      this.characterService.listCharacters(projectId),
      this.worldService.getWorld(projectId),
    ]);

    // Ignore facts whose anchor chapter no longer exists in the live outline:
    // their evidence would point at a missing chapter (rejected by saveDraft),
    // and they are already excluded from the reconstructed view. Only filter when
    // a live outline is available (chapterRank non-empty).
    const facts = rankLookup.chapterRank.size === 0
      ? allFacts
      : allFacts.filter((fact) => rankLookup.chapterRank.has(fact.anchorChapterId));

    // Scenes are needed by the timeline (scene-order collisions) and character
    // (scene membership) detectors. Load once per chapter.
    const scenesByChapter = new Map<string, Scene[]>();
    for (const chapter of chapters) {
      scenesByChapter.set(chapter.id, await this.sceneService.listScenes(chapter.id));
    }

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
    this.detectTimelineContradictions(chapters, scenesByChapter, push);
    this.detectCharacterInconsistencies(characters, facts, rankLookup, chapters, scenesByChapter, push);
    this.detectWorldRuleConflicts(world, entries, facts, push);

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

  /**
   * Timeline detector — contradictory ordering derived ONLY from structured
   * scene `order` fields.
   *
   * The data model has NO explicit in-world timestamps; chapter order and scene
   * `order` are the only objective temporal structure available. A genuine,
   * verifiable ordering fault surfaces when two scenes in the SAME chapter claim
   * the same `order` integer: their relative story position is then ambiguous, so
   * any event anchored to one of them has no well-defined place in time.
   *
   * We deliberately do NOT infer contradictions from continuity facts anchored to
   * *different* chapters — a later chapter legitimately supersedes an earlier
   * value, which is normal flow, not a bug. Emitting on that would be speculative.
   * (This restriction is reported as a known limitation in the handoff doc.)
   */
  private detectTimelineContradictions(
    chapters: Chapter[],
    scenesByChapter: Map<string, Scene[]>,
    push: (draft: FindingDraft) => void,
  ): void {
    for (const chapter of chapters) {
      const scenes = scenesByChapter.get(chapter.id) ?? [];
      if (scenes.length < 2) continue;

      const byOrder = new Map<number, Scene[]>();
      for (const scene of scenes) {
        const list = byOrder.get(scene.order);
        if (list) list.push(scene);
        else byOrder.set(scene.order, [scene]);
      }

      for (const [order, group] of byOrder) {
        if (group.length < 2) continue;
        const evidence: Evidence[] = group.map((scene) => ({
          chapterId: chapter.id,
          sceneId: scene.id,
          quote: scene.title,
          offset: null,
          note: `Scene order ${order}`,
        }));
        push({
          category: 'timeline',
          severity: 'warning',
          origin: 'deterministic',
          title: `Ambiguous scene order in "${chapter.title}"`,
          description:
            `${group.length} scenes in chapter "${chapter.title}" share the same order position (${order}): ` +
            group.map((scene) => `"${scene.title}"`).join(', ') +
            '. Their relative story position is ambiguous, so events anchored to them have no well-defined ' +
            'place in time. Assign distinct scene orders to resolve the timeline.',
          evidence,
        });
      }
    }
  }

  /**
   * Character behavior detector — contradictions supported ONLY by structured
   * data (character `status` field + scene membership + continuity `status` facts).
   *
   * Two objective checks, each requiring concrete structured inputs:
   *   1. A character record whose `status` is `deceased`/`missing`/`active`, but
   *      whose latest continuity `status` fact — in live story order — asserts a
   *      mutually-exclusive state (e.g. record `deceased` vs latest fact `alive`).
   *      Only compared when such a status fact exists; we never guess.
   *   2. A character record marked `unused` that nonetheless appears in a scene
   *      (`characterIds`/`povCharacterId`) — "unused" contradicts being on-page.
   *
   * We deliberately do NOT judge personality/prose, which is subjective and not a
   * deterministic fact.
   */
  private detectCharacterInconsistencies(
    characters: Character[],
    facts: ContinuityFact[],
    rankLookup: { chapterRank: Map<string, number>; sceneRank: Map<string, number> },
    chapters: Chapter[],
    scenesByChapter: Map<string, Scene[]>,
    push: (draft: FindingDraft) => void,
  ): void {
    if (characters.length === 0) return;

    // Latest continuity `status` fact per character subject id, in live order.
    const latestStatusBySubject = new Map<string, ContinuityFact>();
    const statusFactsBySubject = new Map<string, ContinuityFact[]>();
    for (const fact of facts) {
      if (fact.predicate !== 'status' || !fact.subjectId) continue;
      const list = statusFactsBySubject.get(fact.subjectId);
      if (list) list.push(fact);
      else statusFactsBySubject.set(fact.subjectId, [fact]);
    }
    for (const [subjectId, list] of statusFactsBySubject) {
      const ordered = [...list].sort((a, b) => compareFacts(a, b, rankLookup));
      const latest = ordered[ordered.length - 1];
      if (latest) latestStatusBySubject.set(subjectId, latest);
    }

    // Map scene membership back to (chapterId, sceneId) for evidence.
    const sceneLocation = new Map<string, { chapterId: string; sceneId: string }>();
    for (const chapter of chapters) {
      for (const scene of scenesByChapter.get(chapter.id) ?? []) {
        sceneLocation.set(scene.id, { chapterId: chapter.id, sceneId: scene.id });
      }
    }

    for (const character of characters) {
      // Check 1 — record status vs latest continuity status fact.
      const latest = latestStatusBySubject.get(character.id);
      if (latest) {
        const recordState = normalizeLifeState(character.status);
        const factState = classifyStatusValue(latest.value);
        if (recordState && factState && recordState !== factState) {
          const evidence = collectEvidence([latest]);
          if (evidence.length > 0) {
            push({
              category: 'character',
              severity: 'warning',
              origin: 'deterministic',
              title: `"${character.name}"'s status conflicts with recorded events`,
              description:
                `Character "${character.name}" is recorded with status "${character.status}", but the latest ` +
                `continuity status fact says "${latest.value}". Align the character profile with the story state ` +
                'or record the transition that resolves the difference.',
              evidence,
              relatedFactIds: [latest.id],
            });
          }
        }
      }

      // Check 2 — `unused` character appearing in a scene.
      if (character.status === 'unused') {
        let hit: { chapterId: string; sceneId: string } | null = null;
        for (const chapter of chapters) {
          for (const scene of scenesByChapter.get(chapter.id) ?? []) {
            const present =
              scene.povCharacterId === character.id || scene.characterIds.includes(character.id);
            if (present) {
              hit = sceneLocation.get(scene.id) ?? { chapterId: chapter.id, sceneId: scene.id };
              break;
            }
          }
          if (hit) break;
        }
        if (hit) {
          push({
            category: 'character',
            severity: 'info',
            origin: 'deterministic',
            title: `"${character.name}" is marked unused but appears in a scene`,
            description:
              `Character "${character.name}" has status "unused" but is listed in a scene. Either update the ` +
              'character\'s status to reflect that they appear, or remove them from the scene.',
            evidence: [{ chapterId: hit.chapterId, sceneId: hit.sceneId, quote: character.name, offset: null, note: 'Scene membership' }],
          });
        }
      }
    }
  }

  /**
   * World-rule detector — compares a CONCRETE prohibition stated in a
   * rule-classified world section against a CONCRETE contradicting source
   * (a knowledge `rule` entry or a continuity fact) that permits the same term.
   *
   * A rule section is a world section whose title classifies as a rule (see the
   * same heuristic the Knowledge Base importer uses). From its content we extract
   * prohibitions of the form "<term> cannot/never/must not/may not <verb>", yielding
   * a normalized term. For each such prohibition we look for evidence that the
   * SAME term is possible — an affirmative "can/always/allow/allows/may <term>"
   * pattern in a `rule`-kind knowledge entry, or a continuity `attribute`/
   * `possession`/`knowledge` fact whose value names the term.
   *
   * A finding is emitted ONLY when both a prohibition term AND a contradicting
   * source are concretely identified. Free-form world prose that states no
   * recognizable prohibition produces no finding — we never invent rules.
   */
  private detectWorldRuleConflicts(
    world: World | null,
    entries: KnowledgeEntry[],
    facts: ContinuityFact[],
    push: (draft: FindingDraft) => void,
  ): void {
    if (!world) return;

    const ruleSections = world.sections.filter((section) => classifyWorldSectionIsRule(section.title));
    if (ruleSections.length === 0) return;

    // Collect prohibitions: { term, sentence } from each rule section.
    const prohibitions: { term: string; sentence: string }[] = [];
    for (const section of ruleSections) {
      for (const sentence of splitSentences(section.content)) {
        const term = extractProhibitedTerm(sentence);
        if (term) prohibitions.push({ term, sentence });
      }
    }
    if (prohibitions.length === 0) return;

    // Knowledge entries that are rules (kind === 'rule' or rule-tagged).
    const ruleEntries = entries.filter(
      (entry) => entry.kind === 'rule' || entry.tags.some((tag) => /rule|law|magic|system/i.test(tag)),
    );

    for (const { term, sentence } of prohibitions) {
      // Contradiction from a rule knowledge entry that permits the term.
      const contradictingEntry = ruleEntries.find((entry) => entryAllowsTerm(entry, term));
      if (contradictingEntry) {
        const evidence = contradictingEntry.evidence.filter((ev) => ev.chapterId || ev.sceneId);
        if (evidence.length === 0) continue; // no locator → cannot cite → skip
        push({
          category: 'world-rule',
          severity: 'error',
          origin: 'deterministic',
          title: `World rule conflict on "${term}"`,
          description:
            `The world rule states "${sentence.trim()}", but a rule entry "${contradictingEntry.title}" permits ` +
            `"${term}". These two structured rule sources conflict; reconcile them.`,
          evidence,
          relatedEntryIds: [contradictingEntry.id],
        });
        continue;
      }

      // Contradiction from a continuity fact whose value names the term.
      const contradictingFact = facts.find(
        (fact) =>
          ['attribute', 'possession', 'knowledge'].includes(fact.predicate) &&
          termAppears(fact.value, term),
      );
      if (contradictingFact) {
        const evidence = collectEvidence([contradictingFact]);
        if (evidence.length === 0) continue;
        push({
          category: 'world-rule',
          severity: 'error',
          origin: 'deterministic',
          title: `World rule conflict on "${term}"`,
          description:
            `The world rule states "${sentence.trim()}", but a recorded ${contradictingFact.predicate} fact ` +
            `("${contradictingFact.value}") concerns the same term "${term}". Verify whether this violates the rule.`,
          evidence,
          relatedFactIds: [contradictingFact.id],
        });
      }
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

/* -------------------------------------------------------------------------- */
/* Character-status & world-rule helpers                                      */
/* -------------------------------------------------------------------------- */

/** Collapses a character-record status to a coarse life-state, when meaningful. */
function normalizeLifeState(status: string): 'alive' | 'dead' | 'missing' | null {
  switch (status) {
    case 'active':
      return 'alive';
    case 'deceased':
      return 'dead';
    case 'missing':
      return 'missing';
    default:
      return null; // e.g. 'unused' has no life-state to compare
  }
}

/** Classifies a free-text continuity status value into a coarse life-state. */
function classifyStatusValue(value: string): 'alive' | 'dead' | 'missing' | null {
  const v = value.toLowerCase();
  if (/\b(dead|deceased|killed|died|slain)\b/.test(v)) return 'dead';
  if (/\b(missing|lost|vanished|disappeared)\b/.test(v)) return 'missing';
  if (/\b(alive|living|active|awake|healthy|fine|well)\b/.test(v)) return 'alive';
  return null;
}

/** Splits free-form prose into sentence-ish segments for prohibition scanning. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const PROHIBITION_RE = /\b([a-z][a-z'-]{2,})\b[^.!?;]{0,40}?\b(cannot|can't|can not|never|must not|may not|forbidden|prohibited)\b/i;
/** "can/may <term>" but NOT "can never/not <term>" — a negated modal is not permission. */
const PERMISSION_RE = /\b(can|may|allowed|allows|permitted|always|possible|grants?)\b(?!\s+(?:never|not|n't)\b)[^.!?;]{0,40}?\b([a-z][a-z'-]{2,})\b/i;
const NEGATED_MODAL_RE = /\b(cannot|can't|can not|never|must not|may not|forbidden|prohibited)\b/i;

/**
 * Extracts the prohibited term from a sentence like "Mortals cannot wield tide
 * magic" → "mortals". Returns null when no prohibition pattern is present.
 * The term is the subject word immediately before the modal, lower-cased.
 */
function extractProhibitedTerm(sentence: string): string | null {
  const m = PROHIBITION_RE.exec(sentence);
  if (!m) return null;
  const term = m[1].toLowerCase();
  if (STOPWORDS.has(term)) return null;
  return term;
}

/** True when a rule knowledge entry affirmatively permits `term`. */
function entryAllowsTerm(entry: KnowledgeEntry, term: string): boolean {
  const hay = entry.searchText || `${entry.title} ${entry.summary} ${entry.body}`.toLowerCase();
  for (const sentence of splitSentences(hay)) {
    // A sentence that itself states a prohibition never counts as permission
    // (e.g. "Mortals can never wield tide magic" must not read as allowing it).
    if (NEGATED_MODAL_RE.test(sentence)) continue;
    const m = PERMISSION_RE.exec(sentence);
    if (m) {
      const allowed = (m[2] ?? '').toLowerCase();
      if (allowed === term || sentence.includes(term)) return true;
    }
  }
  return false;
}

/** True when `term` appears as a whole word inside `value`. */
function termAppears(value: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(value);
}

/** Rule heuristic mirroring the Knowledge Base importer's section classifier. */
function classifyWorldSectionIsRule(title: string): boolean {
  return /\b(rule|law|magic|system|tech|power|constraint|limitation)\b/i.test(title);
}

const STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'nor', 'not', 'you', 'they', 'them', 'this', 'that',
  'with', 'from', 'into', 'over', 'under', 'only', 'some', 'any', 'all', 'one',
]);
