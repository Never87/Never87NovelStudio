import { ZodError } from 'zod';
import { now } from '@/utils/date';
import { createKnowledgeEntryId } from '@/utils/id';
import type {
  Evidence,
  KnowledgeEntry,
  KnowledgeEntryKind,
  KnowledgeSource,
} from '@/types';
import {
  buildSourceKey,
  deriveSearchText,
} from '@/schemas/knowledge';
import { KnowledgeRepository } from '@/repositories/knowledge-repository';
import { ProjectRepositoryError, ProjectValidationError } from '@/repositories/project-repository';
import { ProjectServiceError } from './project-service';
import { CharacterService } from './character-service';
import { WorldService } from './world-service';
import { OutlineService } from './outline-service';
import { SceneService } from './scene-service';
import { NarrativeService } from './narrative-service';

/** Fields a caller may set when creating a manual knowledge entry. */
export interface CreateKnowledgeInput {
  kind: KnowledgeEntryKind;
  title: string;
  summary?: string;
  body?: string;
  tags?: string[];
  evidence?: Evidence[];
}

/** Fields a caller may change on an entry (origin/source are never re-pointed). */
export interface UpdateKnowledgeInput {
  kind?: KnowledgeEntryKind;
  title?: string;
  summary?: string;
  body?: string;
  tags?: string[];
  evidence?: Evidence[];
}

/** Result of a one-click import/index run. */
export interface ImportKnowledgeResult {
  /** New entries created. */
  imported: number;
  /** Existing entries updated (idempotent re-import). */
  updated: number;
  /** Entities that produced no entry (e.g. empty records) — reported, not errors. */
  skipped: number;
  /**
   * Stale INDEXED entries removed because their source entity no longer exists
   * (e.g. a character/chapter/scene was deleted). Manual entries are never
   * pruned. Reported so the user can see reconciliation happened.
   */
  removed: number;
}

/** Result of a search query. */
export interface KnowledgeSearchResult {
  entries: KnowledgeEntry[];
  /** Lower-cased query used. */
  query: string;
}

/**
 * Business layer for the Knowledge Base (P7).
 *
 * Responsibilities:
 *   - Own ids, timestamps, the derived `searchText`, and default fields.
 *   - Provide CRUD for manual entries.
 *   - Provide IDEMPOTENT import from existing project entities (characters,
 *     world sections, outline chapters, scenes, narrative beats/foreshadowing).
 *     Imports are keyed by a stable `sourceKey` so re-running never duplicates;
 *     the existing entry is UPDATED in place (its `id` is preserved), which also
 *     preserves any user-curated tags/evidence on it where field-level merging
 *     applies. Re-import also RECONCILES: indexed entries whose source entity
 *     was deleted are pruned so no stale/misleading entry remains (manual
 *     entries are never pruned).
 *   - Provide simple, deterministic search over `searchText`.
 *
 * It reads existing entities exclusively through the existing Services, so the
 * import always reflects the current project state and never copies stale data
 * blindly. All writes go through the repository (validated against the schema).
 */
export class KnowledgeService {
  private readonly repository: KnowledgeRepository;
  private readonly characterService: CharacterService;
  private readonly worldService: WorldService;
  private readonly outlineService: OutlineService;
  private readonly sceneService: SceneService;
  private readonly narrativeService: NarrativeService;

  constructor(deps: {
    repository?: KnowledgeRepository;
    characterService?: CharacterService;
    worldService?: WorldService;
    outlineService?: OutlineService;
    sceneService?: SceneService;
    narrativeService?: NarrativeService;
  } = {}) {
    this.repository = deps.repository ?? new KnowledgeRepository();
    this.characterService = deps.characterService ?? new CharacterService();
    this.worldService = deps.worldService ?? new WorldService();
    this.outlineService = deps.outlineService ?? new OutlineService();
    this.sceneService = deps.sceneService ?? new SceneService();
    this.narrativeService = deps.narrativeService ?? new NarrativeService();
  }

  /* ------------------------------ Manual CRUD ----------------------------- */

  async listEntries(projectId: string): Promise<KnowledgeEntry[]> {
    try {
      return await this.repository.getByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to list knowledge entries of project "${projectId}"`);
    }
  }

  async getEntry(id: string): Promise<KnowledgeEntry | null> {
    try {
      return await this.repository.getById(id);
    } catch (error) {
      throw this.wrap(error, `Failed to load knowledge entry "${id}"`);
    }
  }

  /** Creates a manual entry (source = `manual`, no source reference). */
  async createEntry(projectId: string, input: CreateKnowledgeInput): Promise<KnowledgeEntry> {
    const timestamp = now();
    const entry = this.buildEntry({
      id: createKnowledgeEntryId(),
      projectId,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? '',
      body: input.body ?? '',
      tags: input.tags ?? [],
      evidence: input.evidence ?? [],
      source: 'manual',
      sourceRef: { entityType: 'manual', entityId: null, key: null },
      sourceKey: null,
      createdAt: timestamp,
      timestamp,
    });
    try {
      return await this.repository.create(entry);
    } catch (error) {
      throw this.wrap(error, `Failed to create knowledge entry "${input.title}"`);
    }
  }

  /**
   * Updates a manual/indexed entry's editable fields.
   *
   * Origin (`source`/`sourceRef`) is immutable here: editing an imported entry
   * keeps its traceable link. When fields that feed `searchText` change, the
   * derived text is recomputed.
   */
  async updateEntry(projectId: string, id: string, input: UpdateKnowledgeInput): Promise<KnowledgeEntry> {
    const existing = await this.getEntry(id);
    if (!existing || existing.projectId !== projectId) {
      throw new ProjectServiceError(`Knowledge entry "${id}" was not found in project "${projectId}"`);
    }
    const timestamp = now();
    const merged = this.buildEntry({
      ...existing,
      kind: input.kind ?? existing.kind,
      title: input.title ?? existing.title,
      summary: input.summary ?? existing.summary,
      body: input.body ?? existing.body,
      tags: input.tags ?? existing.tags,
      evidence: input.evidence ?? existing.evidence,
      createdAt: existing.createdAt,
      timestamp,
    });
    try {
      return await this.repository.update(merged);
    } catch (error) {
      throw this.wrap(error, `Failed to update knowledge entry "${id}"`);
    }
  }

  async deleteEntry(projectId: string, id: string): Promise<void> {
    const existing = await this.getEntry(id);
    if (!existing || existing.projectId !== projectId) {
      throw new ProjectServiceError(`Knowledge entry "${id}" was not found in project "${projectId}"`);
    }
    try {
      await this.repository.delete(id);
    } catch (error) {
      throw this.wrap(error, `Failed to delete knowledge entry "${id}"`);
    }
  }

  /** Deletes every entry of a project (cascade cleanup). Idempotent. */
  async deleteEntriesOfProject(projectId: string): Promise<number> {
    try {
      return await this.repository.deleteByProjectId(projectId);
    } catch (error) {
      throw this.wrap(error, `Failed to delete knowledge entries of project "${projectId}"`);
    }
  }

  /* --------------------------------- Search ------------------------------- */

  /**
   * Case-insensitive substring search over an entry's derived `searchText`.
   *
   * Deterministic and dependency-free (no vector search): every whitespace-split
   * term must appear. An empty query returns all entries. Order is the
   * repository's (most-recently-updated first).
   */
  async search(projectId: string, query: string): Promise<KnowledgeSearchResult> {
    const entries = await this.listEntries(projectId);
    const normalized = query.trim().toLowerCase();
    if (!normalized) return { entries, query: normalized };
    const terms = normalized.split(/\s+/).filter(Boolean);
    const matched = entries.filter((entry) => {
      const haystack = entry.searchText.length > 0 ? entry.searchText : deriveSearchText(entry);
      return terms.every((term) => haystack.includes(term));
    });
    return { entries: matched, query: normalized };
  }

  /* ------------------------------ Import/index ---------------------------- */

  /**
   * Indexes every supported existing entity of the project into the Knowledge
   * Base. IDEMPOTENT: re-running updates existing entries (by `sourceKey`) and
   * creates nothing that already exists. Safe to call repeatedly.
   *
   * Sources indexed:
   *   - Characters           → kind `character`
   *   - World overview        → kind `concept`   (key `world:<worldId>`)
   *   - World sections        → kind per heuristic (rule/location/concept)
   *   - Outline chapters      → kind `event`
   *   - Scenes                → kind `event` (sub-keyed by scene id)
   *   - Narrative beats        → kind `concept`, tagged `foreshadowing` when the
   *                              beat title/description mentions it, otherwise
   *                              `plot`
   */
  async importFromProject(projectId: string): Promise<ImportKnowledgeResult> {
    const result: ImportKnowledgeResult = { imported: 0, updated: 0, skipped: 0, removed: 0 };

    // Each candidate is an object describing the DESIRED entry state. The common
    // upsert ensures idempotency and updates-in-place.
    const candidates: ImportCandidate[] = [];

    await this.collectCharacterCandidates(projectId, candidates);
    await this.collectWorldCandidates(projectId, candidates);
    await this.collectChapterCandidates(projectId, candidates);
    await this.collectSceneCandidates(projectId, candidates);
    await this.collectNarrativeCandidates(projectId, candidates);

    const liveSourceKeys = new Set<string>();
    for (const candidate of candidates) {
      const key = buildSourceKey(candidate.source, candidate.entityId, candidate.subKey);
      if (key) liveSourceKeys.add(key);
    }

    for (const candidate of candidates) {
      if (!candidate.title.trim()) {
        result.skipped += 1;
        continue;
      }
      const outcome = await this.upsertImported(projectId, candidate);
      if (outcome === 'imported') result.imported += 1;
      else if (outcome === 'updated') result.updated += 1;
      else result.skipped += 1;
    }

    // Reconcile: remove INDEXED entries whose source entity no longer exists, so
    // a deleted character/chapter/scene does not leave a misleading stale entry
    // claiming to come from something that is gone. Manual entries (no sourceKey)
    // are never touched.
    result.removed = await this.pruneStaleIndexedEntries(projectId, liveSourceKeys);

    return result;
  }

  /**
   * Removes indexed entries (source !== `manual`) whose `sourceKey` is not in the
   * current set of live source keys. Returns the number removed. Manual entries
   * and entries with no sourceKey are preserved.
   */
  private async pruneStaleIndexedEntries(projectId: string, liveSourceKeys: Set<string>): Promise<number> {
    const entries = await this.repository.getByProjectId(projectId);
    let removed = 0;
    for (const entry of entries) {
      if (entry.source === 'manual') continue;
      if (!entry.sourceKey) continue;
      if (liveSourceKeys.has(entry.sourceKey)) continue;
      await this.repository.delete(entry.id);
      removed += 1;
    }
    return removed;
  }

  private async collectCharacterCandidates(projectId: string, out: ImportCandidate[]): Promise<void> {
    const characters = await this.characterService.listCharacters(projectId);
    for (const character of characters) {
      out.push({
        source: 'character',
        entityId: character.id,
        kind: 'character',
        title: character.name,
        summary: character.summary,
        body: [
          character.background ? `Background: ${character.background}` : '',
          character.personality ? `Personality: ${character.personality}` : '',
          character.motivation ? `Motivation: ${character.motivation}` : '',
          character.appearance ? `Appearance: ${character.appearance}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        tags: [...character.tags, character.role, character.status].filter(Boolean),
      });
    }
  }

  private async collectWorldCandidates(projectId: string, out: ImportCandidate[]): Promise<void> {
    const world = await this.worldService.getWorld(projectId);
    if (!world) return;

    if (world.overview.trim() || world.title.trim()) {
      out.push({
        source: 'world',
        entityId: world.id,
        kind: 'concept',
        title: world.title || 'World overview',
        summary: world.overview,
        body: world.overview,
        tags: [...world.themes],
      });
    }

    for (const section of world.sections) {
      if (!section.title.trim() && !section.content.trim()) continue;
      out.push({
        source: 'world',
        entityId: world.id,
        subKey: `section:${section.id}`,
        kind: classifyWorldSection(section.title),
        title: section.title || 'World section',
        summary: firstLine(section.content),
        body: section.content,
        tags: world.themes,
      });
    }
  }

  private async collectChapterCandidates(projectId: string, out: ImportCandidate[]): Promise<void> {
    const chapters = await this.outlineService.listProjectChapters(projectId);
    for (const chapter of chapters) {
      out.push({
        source: 'chapter',
        entityId: chapter.id,
        kind: 'event',
        title: chapter.title,
        summary: chapter.summary,
        body: [chapter.goal ? `Goal: ${chapter.goal}` : '', chapter.keyEvents ? `Key events: ${chapter.keyEvents}` : '', chapter.endingHook ? `Ending hook: ${chapter.endingHook}` : '']
          .filter(Boolean)
          .join('\n'),
        tags: [...chapter.tags, 'chapter'],
        evidence: [{ chapterId: chapter.id, sceneId: null, quote: '', offset: null, note: 'Source chapter' }],
      });
    }
  }

  private async collectSceneCandidates(projectId: string, out: ImportCandidate[]): Promise<void> {
    const chapters = await this.outlineService.listProjectChapters(projectId);
    for (const chapter of chapters) {
      const scenes = await this.sceneService.listScenes(chapter.id);
      for (const scene of scenes) {
        out.push({
          source: 'scene',
          entityId: scene.id,
          kind: 'event',
          title: scene.title,
          summary: scene.summary,
          body: [
            scene.location ? `Location: ${scene.location}` : '',
            scene.timeOfDay ? `Time: ${scene.timeOfDay}` : '',
            scene.goal ? `Goal: ${scene.goal}` : '',
            scene.conflict ? `Conflict: ${scene.conflict}` : '',
            scene.outcome ? `Outcome: ${scene.outcome}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          tags: [...scene.tags, 'scene', scene.purpose],
          evidence: [{ chapterId: chapter.id, sceneId: scene.id, quote: '', offset: null, note: 'Source scene' }],
        });
      }
    }
  }

  private async collectNarrativeCandidates(projectId: string, out: ImportCandidate[]): Promise<void> {
    const plan = await this.narrativeService.getPlan(projectId);
    if (!plan) return;

    if (plan.logline.trim()) {
      out.push({
        source: 'narrative',
        entityId: plan.id,
        subKey: 'logline',
        kind: 'concept',
        title: 'Logline',
        summary: plan.logline,
        body: [plan.premise, plan.theme].filter(Boolean).join('\n'),
        tags: [...plan.motifs, 'narrative'],
      });
    }

    for (const beat of plan.beats) {
      if (!beat.title.trim()) continue;
      const isForeshadowing = /foreshadow|seed|plant|setup|setup|payoff|prophec/i.test(`${beat.title} ${beat.description}`);
      out.push({
        source: 'narrative',
        entityId: plan.id,
        subKey: `beat:${beat.id}`,
        kind: 'concept',
        title: beat.title,
        summary: firstLine(beat.description),
        body: beat.description,
        tags: [...plan.motifs, isForeshadowing ? 'foreshadowing' : 'plot', `beat-${beat.position}`],
      });
    }
  }

  /**
   * Upserts one imported candidate by its stable source key.
   *
   * On an existing entry, the searchable fields are refreshed from the source
   * (title/summary/body/tags + recomputed searchText) while preserving the
   * entry's identity — but user-curated `evidence` is preserved if the source
   * supplies none, so re-indexing does not wipe manual annotations.
   */
  private async upsertImported(projectId: string, candidate: ImportCandidate): Promise<'imported' | 'updated' | 'skipped'> {
    const sourceKey = buildSourceKey(candidate.source, candidate.entityId, candidate.subKey);
    if (!sourceKey) return 'skipped';

    const candidateEvidence = candidate.evidence ?? [];
    const existing = await this.repository.getBySourceKey(projectId, sourceKey);
    const timestamp = now();

    if (existing) {
      const merged = this.buildEntry({
        ...existing,
        kind: candidate.kind,
        title: candidate.title,
        summary: candidate.summary,
        body: candidate.body,
        tags: mergeTags(existing.tags, candidate.tags),
        // Preserve user evidence unless the source provides its own.
        evidence: candidateEvidence.length > 0 ? candidateEvidence : existing.evidence,
        createdAt: existing.createdAt,
        timestamp,
      });
      try {
        await this.repository.update(merged);
        return 'updated';
      } catch (error) {
        throw this.wrap(error, `Failed to refresh knowledge entry from source "${sourceKey}"`);
      }
    }

    const entry = this.buildEntry({
      id: createKnowledgeEntryId(),
      projectId,
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      body: candidate.body,
      tags: candidate.tags,
      evidence: candidateEvidence,
      source: candidate.source,
      sourceRef: { entityType: candidate.source, entityId: candidate.entityId, key: sourceKey },
      sourceKey,
      createdAt: timestamp,
      timestamp,
    });
    try {
      await this.repository.create(entry);
      return 'imported';
    } catch (error) {
      throw this.wrap(error, `Failed to import knowledge entry from source "${sourceKey}"`);
    }
  }

  /* ------------------------------- helpers -------------------------------- */

  /** Normalises an entry draft into a fully-validated KnowledgeEntry shape. */
  private buildEntry(base: {
    id: string;
    projectId: string;
    kind: KnowledgeEntryKind;
    title: string;
    summary: string;
    body: string;
    tags: string[];
    evidence: Evidence[];
    source: KnowledgeSource;
    sourceRef: KnowledgeEntry['sourceRef'];
    sourceKey: string | null;
    createdAt: number;
    timestamp: number;
  }): KnowledgeEntry {
    return {
      id: base.id,
      projectId: base.projectId,
      kind: base.kind,
      title: base.title,
      summary: base.summary,
      body: base.body,
      tags: base.tags,
      source: base.source,
      sourceRef: base.sourceRef,
      sourceKey: base.sourceKey,
      evidence: base.evidence,
      searchText: deriveSearchText({ title: base.title, summary: base.summary, body: base.body, tags: base.tags }),
      createdAt: base.createdAt,
      updatedAt: base.timestamp,
    };
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

/** A desired entry derived from an existing entity. */
interface ImportCandidate {
  source: KnowledgeSource;
  entityId: string;
  /** Disambiguates multiple entries from one entity (world sections, beats). */
  subKey?: string;
  kind: KnowledgeEntryKind;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  /** Optional evidence; absence is fine (not all sources have a manuscript locator). */
  evidence?: Evidence[];
}

/** Heuristic: pick a knowledge kind from a world section heading. */
function classifyWorldSection(title: string): KnowledgeEntryKind {
  const heading = title.toLowerCase();
  if (/location|place|geography|region|city|town|land|map/.test(heading)) return 'location';
  if (/rule|law|magic|system|tech|power/.test(heading)) return 'rule';
  if (/faction|group|order|guild|house|clan|society|religion/.test(heading)) return 'faction';
  if (/history|event|timeline|war|era|age/.test(heading)) return 'event';
  if (/item|artifact|weapon|relic|object/.test(heading)) return 'item';
  return 'concept';
}

/** First non-empty line, trimmed (for a list summary). */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 500 ? line.slice(0, 500) : line;
}

/** Union of two tag lists, de-duplicated and trimmed. */
function mergeTags(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of [...incoming, ...existing]) {
    const trimmed = tag.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.slice(0, 50);
}
