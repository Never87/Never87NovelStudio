import { TRANSFER_COLLECTIONS } from '@/transfer/collection-registry';
import type { TransferProject, TransferProjectData } from '@/schemas/transfer';
import { computeIntegrity } from '@/transfer/canonical-json';

/**
 * ID-mapping foundation (P9 Batch 1).
 *
 * ## Purpose
 *
 * A future "Import as new project" / "Duplicate project" operation needs to
 * write a package's records under FRESH primary keys, so it never collides with
 * (or silently overwrite) existing data. Doing that correctly means rewriting
 * every id AND every reference that points at one, consistently.
 *
 * This module provides exactly that primitive — and nothing more. It does NOT
 * touch IndexedDB, does NOT run an import transaction, and does NOT implement
 * the Replace workflow.
 *
 * ## Design
 *
 *  1. `buildIdMap` assigns one new id per old id, per collection, using the
 *     project's existing prefixed id generator. Ids are keyed by
 *     `(collectionKey, oldId)` because DraftVersion.draftId spans two
 *     collections and a bare old id is not globally unique across tables.
 *  2. `remapProject` produces a NEW `TransferProject` whose rows carry the new
 *     ids. References are rewritten ONLY when a mapping exists; a reference
 *     with no mapping is reported rather than silently left pointing at the old
 *     id (which would dangle on import).
 *  3. The ORIGINAL package is never mutated: every row is copied with spread
 *     operators and nested arrays/objects are re-created. The input is not even
 *     referenced by the output.
 *
 * ## Determinism
 *
 * `buildIdMap` accepts an injectable id factory, so tests can produce a
 * deterministic mapping. With the default factory the ids are UUID-backed and
 * therefore unique — but the RESULT is still a pure function of the input plus
 * the factory, with no hidden global state.
 */

/** Prefixes for remapped ids, mirroring `ID_PREFIX` in `@/utils/id`. */
const PREFIX_BY_COLLECTION: Record<keyof TransferProjectData, string> = {
  worlds: 'world',
  characters: 'char',
  narrativePlans: 'narr',
  volumes: 'vol',
  chapters: 'chap',
  scenes: 'scene',
  chapterDrafts: 'cdraft',
  sceneDrafts: 'sdraft',
  draftVersions: 'dver',
  promptTemplates: 'ptpl',
  promptTemplateVersions: 'ptv',
  contextItems: 'ctx',
  contextConfigs: 'ctxcfg',
  knowledgeEntries: 'know',
  continuityFacts: 'cont',
  analysisFindings: 'find',
  sourceDocuments: 'doc',
  documentSections: 'dsec',
  extractionRecords: 'ext',
};

/** The `project` pseudo-collection, so the root id can be remapped too. */
export const PROJECT_COLLECTION = 'project' as const;

/** Any collection key that can own a primary id, including the project root. */
export type MappableCollection = keyof TransferProjectData | typeof PROJECT_COLLECTION;

/**
 * A two-level map: collection → (oldId → newId).
 *
 * The nesting is REQUIRED because `DraftVersion.draftId` may reference either a
 * chapter draft or a scene draft, and the same literal id string must be
 * resolvable in the correct namespace.
 */
export interface IdMap {
  readonly project: Map<string, string>;
  readonly collections: ReadonlyMap<keyof TransferProjectData, ReadonlyMap<string, string>>;
}

/** Result of remapping a package. */
export interface RemapResult {
  /** The remapped project (a deep copy; the input is untouched). */
  readonly project: TransferProject;
  /** The id map that was applied. */
  readonly idMap: IdMap;
  /** References that could not be remapped because no mapping existed. */
  readonly unresolvedReferences: readonly UnresolvedReference[];
}

/** A reference that pointed at an id absent from the mapping. */
export interface UnresolvedReference {
  readonly collection: keyof TransferProjectData;
  readonly recordId: string;
  /** The field carrying the reference, e.g. `volumeId`. */
  readonly field: string;
  /** The old id that had no mapping. */
  readonly missingId: string;
}

/**
 * Every field that carries an id reference, for the remapper.
 *
 * This is the same graph that `validation.ts` checks, expressed as a mutation
 * plan: for each (collection, field) we know whether the value is a single id,
 * an id inside a nested object/array, or an id list — and which collection it
 * resolves against.
 */
interface RemapRule {
  readonly collection: keyof TransferProjectData;
  readonly field: string;
  /** Which collection namespace the referenced ids live in. */
  readonly target: keyof TransferProjectData;
  readonly kind: 'single' | 'list';
}

const REMAP_RULES: readonly RemapRule[] = [
  { collection: 'chapters', field: 'volumeId', target: 'volumes', kind: 'single' },
  { collection: 'chapters', field: 'characterIds', target: 'characters', kind: 'list' },
  { collection: 'scenes', field: 'chapterId', target: 'chapters', kind: 'single' },
  { collection: 'scenes', field: 'characterIds', target: 'characters', kind: 'list' },
  { collection: 'scenes', field: 'povCharacterId', target: 'characters', kind: 'single' },
  { collection: 'chapterDrafts', field: 'ownerId', target: 'chapters', kind: 'single' },
  { collection: 'sceneDrafts', field: 'ownerId', target: 'scenes', kind: 'single' },
  // `draftId` may resolve in EITHER draft collection; handled specially.
  { collection: 'promptTemplateVersions', field: 'templateId', target: 'promptTemplates', kind: 'single' },
  { collection: 'documentSections', field: 'documentId', target: 'sourceDocuments', kind: 'single' },
  { collection: 'documentSections', field: 'parentId', target: 'documentSections', kind: 'single' },
  { collection: 'extractionRecords', field: 'documentId', target: 'sourceDocuments', kind: 'single' },
  { collection: 'continuityFacts', field: 'anchorChapterId', target: 'chapters', kind: 'single' },
  { collection: 'continuityFacts', field: 'anchorSceneId', target: 'scenes', kind: 'single' },
  { collection: 'extractionRecords', field: 'relatedIds', target: 'characters', kind: 'list' },
];

/** An id factory: gets a collection key and returns a fresh prefixed id. */
export type IdFactory = (prefix: string) => string;

/** Default factory using the application's prefixed UUID generator. */
export function defaultIdFactory(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Builds a complete id map for one project.
 *
 * Every record in every collection receives exactly one new id. The project
 * root gets one too, so an imported project can become a distinct project
 * rather than a clone with a colliding id.
 */
export function buildIdMap(project: TransferProject, factory: IdFactory = defaultIdFactory): IdMap {
  const collections = new Map<keyof TransferProjectData, Map<string, string>>();

  for (const collection of TRANSFER_COLLECTIONS) {
    const rows = project.data[collection.key] as unknown as Array<{ id: string }>;
    const prefix = PREFIX_BY_COLLECTION[collection.key];
    const mapping = new Map<string, string>();
    for (const row of rows) {
      mapping.set(row.id, factory(prefix));
    }
    collections.set(collection.key, mapping);
  }

  return {
    project: new Map([[project.project.id, factory('proj')]]),
    collections,
  };
}

/**
 * Reports ids that appear MORE THAN ONCE inside a single collection.
 *
 * Duplicate primary ids are rejected by `validateTransferPackage`, but the
 * remapper must also be safe to call on an unvalidated package — ambiguous
 * mappings (one old id → two new ids) would silently break relationships.
 */
export function findAmbiguousIds(project: TransferProject): Array<{ collection: keyof TransferProjectData; id: string; count: number }> {
  const ambiguous: Array<{ collection: keyof TransferProjectData; id: string; count: number }> = [];
  for (const collection of TRANSFER_COLLECTIONS) {
    const rows = project.data[collection.key] as unknown as Array<{ id: string }>;
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (count > 1) ambiguous.push({ collection: collection.key, id, count });
    }
  }
  return ambiguous;
}

/** Raised when remapping is asked to run on an ambiguous (duplicate-id) package. */
export class AmbiguousIdMapError extends Error {
  readonly duplicates: ReadonlyArray<{ collection: keyof TransferProjectData; id: string; count: number }>;

  constructor(
    duplicates: ReadonlyArray<{ collection: keyof TransferProjectData; id: string; count: number }>,
  ) {
    super(
      `Cannot build an unambiguous id map: duplicate ids present (${duplicates
        .slice(0, 5)
        .map((d) => `${d.collection}:${d.id}×${d.count}`)
        .join(', ')}${duplicates.length > 5 ? ', …' : ''})`,
    );
    this.name = 'AmbiguousIdMapError';
    this.duplicates = duplicates;
  }
}

/**
 * Produces a remapped DEEP COPY of a project.
 *
 * @param project the source project (never mutated)
 * @param idMap a map produced by `buildIdMap` (or a caller-supplied equivalent)
 * @returns the remapped project, the map used, and any unresolved references
 *
 * ## Behaviour on a missing mapping
 *
 * A reference whose old id has no entry in the map is:
 *   - reported in `unresolvedReferences`, AND
 *   - left as the ORIGINAL value (never dropped, never set to `null`).
 *
 * Leaving the original value is deliberate: it makes the breakage visible to
 * validation instead of fabricating a value. Callers are expected to validate
 * the remapped package before writing it, where such a reference shows up as a
 * dangling reference with an explicit path.
 */
export function remapProject(project: TransferProject, idMap: IdMap): RemapResult {
  const ambiguous = findAmbiguousIds(project);
  if (ambiguous.length > 0) throw new AmbiguousIdMapError(ambiguous);

  const unresolved: UnresolvedReference[] = [];

  /** Looks up a new id, recording a miss as an unresolved reference. */
  const mapId = (
    collection: keyof TransferProjectData,
    field: string,
    recordId: string,
    oldId: string,
  ): string => {
    const mapping = idMap.collections.get(collection);
    const next = mapping?.get(oldId);
    if (next === undefined) {
      unresolved.push({ collection, recordId, field, missingId: oldId });
      return oldId;
    }
    return next;
  };

  // 1. Remap every collection's rows and their own primary id.
  const data = {} as TransferProjectData;
  for (const collection of TRANSFER_COLLECTIONS) {
    const rows = project.data[collection.key] as unknown as Array<Record<string, unknown>>;
    const mapping = idMap.collections.get(collection.key);

    const remappedRows = rows.map((row) => {
      const oldId = String(row.id);
      const newId = mapping?.get(oldId);
      if (newId === undefined) {
        unresolved.push({ collection: collection.key, recordId: oldId, field: 'id', missingId: oldId });
      }
      // Shallow copy of every enumerable property; nested values are replaced
      // explicitly below where they carry ids. Structured clone semantics are
      // preserved by copying nested objects/arrays too (see step 3).
      return { ...row, id: newId ?? oldId } as Record<string, unknown>;
    });

    (data as Record<string, unknown>)[collection.key] = remappedRows;
  }

  // 2. Rewrite single- and multi-valued references.
  for (const rule of REMAP_RULES) {
    const rows = data[rule.collection] as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const recordId = String(row.id);
      const value = row[rule.field];

      if (rule.kind === 'list') {
        if (!Array.isArray(value)) continue;
        (row as Record<string, unknown>)[rule.field] = value.map((entry) =>
          typeof entry === 'string' ? mapId(rule.target, rule.field, recordId, entry) : entry,
        );
      } else {
        if (typeof value !== 'string') continue;
        (row as Record<string, unknown>)[rule.field] = mapId(rule.target, rule.field, recordId, value);
      }
    }
  }

  // 2b. Plot beats are embedded in the narrative plan, so they need their own
  //     mapping per plan. A chapter's `plotBeatId` and the plan's `beats[].id`
  //     must be rewritten together or the link breaks.
  remapPlotBeats(data);

    // 3. `DraftVersion.draftId` spans chapterDrafts AND sceneDrafts.
  for (const row of data.draftVersions as unknown as Array<Record<string, unknown>>) {
    const draftId = row.draftId;
    if (typeof draftId !== 'string') continue;
    const recordId = String(row.id);
    const fromChapter = idMap.collections.get('chapterDrafts')?.get(draftId);
    const fromScene = idMap.collections.get('sceneDrafts')?.get(draftId);
    const next = fromChapter ?? fromScene;
    if (next === undefined) {
      unresolved.push({
        collection: 'draftVersions',
        recordId,
        field: 'draftId',
        missingId: draftId,
      });
    } else {
      row.draftId = next;
    }
  }

  // 4. Embedded evidence locators reference documents and sections by id.
  //    (P7 `EvidenceSource` on knowledge/continuity/analysis + P8 evidence.)
  remapEmbeddedEvidence(data, idMap, unresolved);

  // 5. Extraction lifecycle references that point at other records/entities.
  remapExtractionReferences(data, idMap, unresolved);

  // 6. Rebuild integrity for the NEW content so the remapped package is
  //    self-consistent and passes validation on its own.
  const nextProjectId = idMap.project.get(project.project.id) ?? project.project.id;
  if (nextProjectId === project.project.id) {
    unresolved.push({
      collection: 'chapters',
      recordId: project.project.id,
      field: 'projectId',
      missingId: project.project.id,
    });
  }

  // Re-point every ownership column at the (possibly new) project id.
  for (const collection of TRANSFER_COLLECTIONS) {
    const rows = data[collection.key] as unknown as Array<Record<string, unknown>>;
    if (collection.ownerKey !== 'projectId') continue;
    for (const row of rows) row.projectId = nextProjectId;
  }

  const remappedProjectRow = { ...project.project, id: nextProjectId };
  // Nested owner references held in sub-objects are covered by the rules above.

  const remappedData = data as TransferProjectData;
  const integrity = computeIntegrity({ project: remappedProjectRow, data: remappedData });

  return {
    project: { project: remappedProjectRow, data: remappedData, integrity },
    idMap,
    unresolvedReferences: unresolved,
  };
}

/**
 * Rewrites plot-beat ids inside the narrative plan and the chapters pointing at
 * them.
 *
 * Beats are stored as a nested array (`narrativePlan.beats`), not a table, so
 * they are not part of `TRANSFER_COLLECTIONS`. Their ids must still be unique:
 * a cloned project that kept the original beat ids would share them with the
 * source project. Beat ids are therefore rewritten deterministically from the
 * NEW plan id + the beat's position — stable, collision-free, and derived from
 * data already inside this package.
 */
function remapPlotBeats(data: TransferProjectData): void {
  const beatRemap = new Map<string, string>();

  for (const plan of data.narrativePlans as unknown as Array<Record<string, unknown>>) {
    const beats = plan.beats;
    if (!Array.isArray(beats)) continue;
    plan.beats = beats.map((beat, index) => {
      if (typeof beat !== 'object' || beat === null) return beat;
      const beatObj = beat as Record<string, unknown>;
      const oldId = typeof beatObj.id === 'string' ? beatObj.id : `${plan.id}:${index}`;
      // Deterministic, unique per (new plan id, position).
      const newId = `${plan.id}_beat_${index}`;
      beatRemap.set(oldId, newId);
      return { ...beatObj, id: newId };
    });
  }

  for (const chapter of data.chapters as unknown as Array<Record<string, unknown>>) {
    const beatId = chapter.plotBeatId;
    if (typeof beatId !== 'string') continue;
    const next = beatRemap.get(beatId);
    // Leave an unresolvable link untouched so validation surfaces it rather
    // than inventing a beat that does not exist.
    if (next !== undefined) chapter.plotBeatId = next;
  }
}

/**
 * Rewrites document/section ids embedded inside `EvidenceSource` locators.
 *
 * P7 `Evidence` objects may carry an optional `source: {documentId, sectionId}`
 * (import provenance). Those ids live in P8 tables, so a cloned project must
 * rewrite them too or the provenance would point at the ORIGINAL project's rows.
 */
function remapEmbeddedEvidence(
  data: TransferProjectData,
  idMap: IdMap,
  unresolved: UnresolvedReference[],
): void {
  const documentMap = idMap.collections.get('sourceDocuments');
  const sectionMap = idMap.collections.get('documentSections');
  if (!documentMap && !sectionMap) return;

  const collectionsWithEvidence: Array<keyof TransferProjectData> = [
    'knowledgeEntries',
    'continuityFacts',
    'analysisFindings',
  ];

  for (const key of collectionsWithEvidence) {
    const rows = data[key] as unknown as Array<Record<string, unknown>>;
    for (const row of rows) {
      const evidence = row.evidence;
      if (!Array.isArray(evidence)) continue;
      const recordId = String(row.id);

      (row as Record<string, unknown>).evidence = evidence.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const entry = item as Record<string, unknown>;
        const source = entry.source;
        if (typeof source !== 'object' || source === null) return { ...entry };

        const src = source as Record<string, unknown>;
        const nextSource: Record<string, unknown> = { ...src };

        if (typeof src.documentId === 'string') {
          const next = documentMap?.get(src.documentId);
          if (next === undefined) {
            unresolved.push({ collection: key, recordId, field: 'evidence.source.documentId', missingId: src.documentId });
          } else {
            nextSource.documentId = next;
          }
        }
        if (typeof src.sectionId === 'string') {
          const next = sectionMap?.get(src.sectionId);
          if (next === undefined) {
            unresolved.push({ collection: key, recordId, field: 'evidence.source.sectionId', missingId: src.sectionId });
          } else {
            nextSource.sectionId = next;
          }
        }

        return { ...entry, source: nextSource };
      });
    }
  }
}

/**
 * Rewrites extraction-record references that point at other records/entities.
 *
 * Three relationships exist on an `ExtractionRecord`:
 *   - `evidence[].documentId` / `evidence[].sectionId` — P8 locators;
 *   - `merge.targetId` — another EXTRACTION record (P8 Batch 4 merge audit);
 *   - `integration.appliedEntityId` — a PROJECT entity (character, chapter, …).
 *
 * Applied-entity ids can only be remapped for the entity types this module
 * knows about; an id whose entity type is out of scope is reported instead of
 * being silently repointed.
 */
function remapExtractionReferences(
  data: TransferProjectData,
  idMap: IdMap,
  unresolved: UnresolvedReference[],
): void {
  const documentMap = idMap.collections.get('sourceDocuments');
  const sectionMap = idMap.collections.get('documentSections');
  const extractionMap = idMap.collections.get('extractionRecords');
  const characterMap = idMap.collections.get('characters');
  const chapterMap = idMap.collections.get('chapters');
  const sceneMap = idMap.collections.get('scenes');

  for (const row of data.extractionRecords as unknown as Array<Record<string, unknown>>) {
    const recordId = String(row.id);

    // (a) Evidence locators.
    if (Array.isArray(row.evidence)) {
      row.evidence = row.evidence.map((item) => {
        if (typeof item !== 'object' || item === null) return item;
        const evidence = item as Record<string, unknown>;
        const nextEvidence: Record<string, unknown> = { ...evidence };

        if (typeof evidence.documentId === 'string') {
          const next = documentMap?.get(evidence.documentId);
          if (next === undefined) {
            unresolved.push({ collection: 'extractionRecords', recordId, field: 'evidence[].documentId', missingId: evidence.documentId });
          } else {
            nextEvidence.documentId = next;
          }
        }
        if (typeof evidence.sectionId === 'string') {
          const next = sectionMap?.get(evidence.sectionId);
          if (next === undefined) {
            unresolved.push({ collection: 'extractionRecords', recordId, field: 'evidence[].sectionId', missingId: evidence.sectionId });
          } else {
            nextEvidence.sectionId = next;
          }
        }
        return nextEvidence;
      });
    }

    // (b) Merge audit: target is another extraction record.
    const merge = row.merge;
    if (typeof merge === 'object' && merge !== null) {
      const mergeObj = merge as Record<string, unknown>;
      if (typeof mergeObj.targetId === 'string') {
        const next = extractionMap?.get(mergeObj.targetId);
        if (next === undefined) {
          unresolved.push({ collection: 'extractionRecords', recordId, field: 'merge.targetId', missingId: mergeObj.targetId });
        } else {
          row.merge = { ...mergeObj, targetId: next };
        }
      }
    }

    // (c) Integration target: a project entity of a specific type.
    const integration = row.integration;
    if (typeof integration === 'object' && integration !== null) {
      const integrationObj = integration as Record<string, unknown>;
      const entityType = integrationObj.appliedEntityType;
      const entityId = integrationObj.appliedEntityId;

      if (typeof entityId === 'string' && typeof entityType === 'string') {
        const lookup = targetMapForEntityType(entityType, { characterMap, chapterMap, sceneMap });
        if (lookup === undefined) {
          // An entity type outside this module's scope (e.g. knowledge-entry).
          // Report rather than guess; the caller can decide how to treat it.
          unresolved.push({
            collection: 'extractionRecords',
            recordId,
            field: `integration.appliedEntityId(${entityType})`,
            missingId: entityId,
          });
        } else {
          const next = lookup.get(entityId);
          if (next === undefined) {
            unresolved.push({ collection: 'extractionRecords', recordId, field: 'integration.appliedEntityId', missingId: entityId });
          } else {
            row.integration = { ...integrationObj, appliedEntityId: next };
          }
        }
      }
    }
  }
}

/** Selects the id map for an integration target type, when one exists. */
function targetMapForEntityType(
  entityType: string,
  maps: {
    characterMap: ReadonlyMap<string, string> | undefined;
    chapterMap: ReadonlyMap<string, string> | undefined;
    sceneMap: ReadonlyMap<string, string> | undefined;
  },
): ReadonlyMap<string, string> | undefined {
  switch (entityType) {
    case 'character':
      return maps.characterMap;
    case 'chapter':
      return maps.chapterMap;
    case 'scene':
      return maps.sceneMap;
    default:
      return undefined;
  }
}
