/**
 * Entity id generation.
 *
 * Ids are `crypto.randomUUID()` values with a short, human-readable prefix so
 * they are identifiable in DevTools and exported backups (e.g. `proj_9f2c…`).
 * `Math.random()` is never used — it is not a valid uniqueness source.
 */

/** Prefixes for every entity type. Keep in sync with the Dexie schema. */
export const ID_PREFIX = {
  project: 'proj',
  world: 'world',
  worldSection: 'wsec',
  character: 'char',
  narrativePlan: 'narr',
  plotBeat: 'beat',
  volume: 'vol',
  chapter: 'chap',
  scene: 'scene',
  chapterDraft: 'cdraft',
  sceneDraft: 'sdraft',
  draftVersion: 'dver',
  // P5 — AI configuration entities.
  aiProvider: 'prov',
  aiModel: 'model',
  aiTaskConfig: 'aifcfg',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

/**
 * Generates a prefixed unique id.
 *
 * @example createId(ID_PREFIX.project) // 'proj_1f0c6c1e-…'
 */
export function createId(prefix: IdPrefix): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** Convenience wrapper for project ids. */
export function createProjectId(): string {
  return createId(ID_PREFIX.project);
}

/** Convenience wrapper for world ids. */
export function createWorldId(): string {
  return createId(ID_PREFIX.world);
}

/** Convenience wrapper for world section ids. */
export function createWorldSectionId(): string {
  return createId(ID_PREFIX.worldSection);
}

/** Convenience wrapper for character ids. */
export function createCharacterId(): string {
  return createId(ID_PREFIX.character);
}

/** Convenience wrapper for narrative-plan ids. */
export function createNarrativePlanId(): string {
  return createId(ID_PREFIX.narrativePlan);
}

/** Convenience wrapper for plot-beat ids. */
export function createPlotBeatId(): string {
  return createId(ID_PREFIX.plotBeat);
}

/** Convenience wrapper for volume ids. */
export function createVolumeId(): string {
  return createId(ID_PREFIX.volume);
}

/** Convenience wrapper for chapter ids. */
export function createChapterId(): string {
  return createId(ID_PREFIX.chapter);
}

/** Convenience wrapper for scene ids. */
export function createSceneId(): string {
  return createId(ID_PREFIX.scene);
}

/** Convenience wrapper for chapter-manuscript ids. */
export function createChapterDraftId(): string {
  return createId(ID_PREFIX.chapterDraft);
}

/** Convenience wrapper for scene-manuscript ids. */
export function createSceneDraftId(): string {
  return createId(ID_PREFIX.sceneDraft);
}

/** Convenience wrapper for manuscript-version ids. */
export function createDraftVersionId(): string {
  return createId(ID_PREFIX.draftVersion);
}

/** Convenience wrapper for AI provider configuration ids. */
export function createAiProviderId(): string {
  return createId(ID_PREFIX.aiProvider);
}

/** Convenience wrapper for AI model configuration ids. */
export function createAiModelId(): string {
  return createId(ID_PREFIX.aiModel);
}

/** Convenience wrapper for per-task AI model assignment ids. */
export function createAiTaskConfigId(): string {
  return createId(ID_PREFIX.aiTaskConfig);
}

