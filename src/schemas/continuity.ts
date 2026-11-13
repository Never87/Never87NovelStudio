import { z } from 'zod';
import { EvidenceSchema } from './knowledge';

/**
 * Continuity domain schemas (P7) — single source of truth.
 *
 * Continuity is modelled as an EVENT-SOURCED FACT LIST, never as a mutable
 * per-character snapshot. Each `ContinuityFact` records a state claim about a
 * subject (character/item/location/faction) that becomes true at a specific
 * anchor in the story (a chapter, optionally a scene, with a story-order rank).
 *
 * Reconstructing "what was true as of chapter N" is a deterministic FOLD over
 * the facts whose anchors precede N, in a stable order:
 *
 *   1. anchor rank        (story order — see `anchorRank` below)
 *   2. scene order        (within a chapter, when both have scene anchors)
 *   3. recordedAt         (creation time of the fact — a later record wins ties)
 *   4. id                 (final, deterministic tie-breaker)
 *
 * The Service computes `anchorRank` from the CURRENT outline order each time it
 * reconstructs state, so REORDERING chapters can never silently make a stored
 * rank wrong — the rank is not trusted from storage when a live outline is
 * available. (Facts still persist `anchorRank` as a best-effort cache so a
 * project with no outline can still order facts.)
 *
 * tsconfig constraints honoured here:
 *   - `erasableSyntaxOnly`: no `enum`; literal unions + `z.enum`.
 *   - `verbatimModuleSyntax`: type-only imports use `import type`.
 */

/* -------------------------------------------------------------------------- */
/* Subjects & predicates                                                      */
/* -------------------------------------------------------------------------- */

/** What a continuity fact is about. */
export const CONTINUITY_SUBJECT_TYPES = ['character', 'item', 'location', 'faction', 'other'] as const;
export const ContinuitySubjectTypeSchema = z.enum(CONTINUITY_SUBJECT_TYPES);
export type ContinuitySubjectType = z.infer<typeof ContinuitySubjectTypeSchema>;

/**
 * What predicate a fact asserts about its subject.
 *
 *   - `position`     — where the subject is.
 *   - `possession`   — what the subject holds/carries.
 *   - `knowledge`    — what the subject knows (a secret revealed, etc.).
 *   - `relationship` — how the subject relates to another party.
 *   - `status`       — alive/dead/missing/injured/etc.
 *   - `attribute`    — any other changing attribute (appearance, allegiance).
 */
export const CONTINUITY_PREDICATES = [
  'position',
  'possession',
  'knowledge',
  'relationship',
  'status',
  'attribute',
] as const;
export const ContinuityPredicateSchema = z.enum(CONTINUITY_PREDICATES);
export type ContinuityPredicate = z.infer<typeof ContinuityPredicateSchema>;

/* -------------------------------------------------------------------------- */
/* Facts                                                                      */
/* -------------------------------------------------------------------------- */

const timestampSchema = z
  .number()
  .int('Timestamp must be an integer')
  .nonnegative('Timestamp must be non-negative');

/**
 * A single event-sourced continuity fact.
 *
 * Facts are APPEND-FRIENDLY and immutable in spirit: editing a fact replaces its
 * value but keeps its identity; the point is that the COLLECTION forms an ordered
 * log from which any point-in-time state is derived. The Service writes the
 * cached `anchorRank`; reconstruction recomputes it from the live outline.
 */
export const ContinuityFactSchema = z
  .object({
    /** Stable primary key, prefixed (`cont_…`). */
    id: z.string().min(1, 'Continuity fact id is required'),
    /** Owning project. Indexed. */
    projectId: z.string().min(1, 'Continuity fact projectId is required'),

    subjectType: ContinuitySubjectTypeSchema,
    /** Id of the subject entity (character/item/location/…) when applicable. */
    subjectId: z.string().min(1).nullable(),
    /** Display label for the subject (survives deletion of the entity). */
    subjectLabel: z.string().trim().max(200).default(''),

    predicate: ContinuityPredicateSchema,
    /** The asserted value, e.g. "the harbour", "the silver key", "dead". */
    value: z.string().trim().min(1, 'A fact value is required').max(2_000, 'Value must be at most 2000 characters'),
    /** Optional secondary party for relationship facts. */
    relatedLabel: z.string().trim().max(200).default(''),

    /** Anchor: the chapter at which this fact becomes true. Required. */
    anchorChapterId: z.string().min(1, 'A fact must be anchored to a chapter'),
    /** Anchor scene, when more precise than the chapter. */
    anchorSceneId: z.string().min(1).nullable(),

    /**
     * Cached story-order rank of the anchor (derived from the outline). Used only
     * when a live outline is unavailable; reconstruction prefers the live order.
     */
    anchorRank: z.number().int().nonnegative().default(0),

    /** Optional evidence supporting the fact. */
    evidence: z.array(EvidenceSchema).max(20).default([]),

    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .refine((fact) => fact.updatedAt >= fact.createdAt, {
    message: 'updatedAt cannot be earlier than createdAt',
    path: ['updatedAt'],
  });

export type ContinuityFact = z.infer<typeof ContinuityFactSchema>;

/* -------------------------------------------------------------------------- */
/* State reconstruction (pure)                                                */
/* -------------------------------------------------------------------------- */

/** A subject's reconstructed state-value for one predicate. */
export interface ReconstructedStateValue {
  predicate: ContinuityPredicate;
  value: string;
  relatedLabel: string;
  /** The fact that produced this value. */
  fact: ContinuityFact;
}

/**
 * The total ordering used to fold facts deterministically.
 *
 * @param a first fact
 * @param b second fact
 * @param liveRank optional map (chapterId → rank, and sceneId → rank) from a
 *   LIVE outline; when present it overrides each fact's cached `anchorRank`, so
 *   chapter reordering is always respected. Tie-breaks: scene rank, recordedAt,
 *   then id.
 */
export function compareFacts(
  a: ContinuityFact,
  b: ContinuityFact,
  liveRank?: LiveRankLookup,
): number {
  const rankA = rankOf(a, liveRank);
  const rankB = rankOf(b, liveRank);
  if (rankA !== rankB) return rankA - rankB;

  const sceneA = sceneRankOf(a, liveRank);
  const sceneB = sceneRankOf(b, liveRank);
  if (sceneA !== sceneB) return sceneA - sceneB;

  // A later-recorded fact wins a tie (it supersedes an earlier assertion).
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Maps a chapter/scene id to a live story-order rank.
 *
 * When `liveRank` is provided and knows the chapter, its rank is authoritative.
 * Otherwise the fact's cached `anchorRank` is used (best effort).
 */
export type LiveRankLookup = {
  chapterRank: Map<string, number>;
  sceneRank: Map<string, number>;
} | null;

function rankOf(fact: ContinuityFact, liveRank: LiveRankLookup | undefined): number {
  const live = liveRank?.chapterRank.get(fact.anchorChapterId);
  return live !== undefined ? live : fact.anchorRank;
}

function sceneRankOf(fact: ContinuityFact, liveRank: LiveRankLookup | undefined): number {
  if (!fact.anchorSceneId) return -1;
  const live = liveRank?.sceneRank.get(fact.anchorSceneId);
  return live !== undefined ? live : -1;
}

/**
 * Folds facts into a point-in-time state.
 *
 * @param facts all facts of a project (any order)
 * @param options.beforeRanks facts whose anchor rank is >= `beforeRanks.stopRank`
 *   are excluded (i.e. state "as of" — not including — a chapter); when omitted
 *   the full state after all facts is returned.
 * @param options.liveRank live outline ranks; when provided they override cached
 *   ranks so reordering cannot corrupt reconstruction.
 * @returns one entry per subject+predicate, keyed `subjectType:subjectId:predicate`.
 *
 * The fold is order-independent on input (facts are sorted first) and fully
 * deterministic, satisfying the stable-ordering requirement.
 */
export function reconstructState(
  facts: ContinuityFact[],
  options: { stopRank?: number; liveRank?: LiveRankLookup } = {},
): Map<string, ReconstructedStateValue> {
  const sorted = [...facts].sort((a, b) => compareFacts(a, b, options.liveRank));
  const state = new Map<string, ReconstructedStateValue>();
  const stopRank = options.stopRank;

  for (const fact of sorted) {
    if (stopRank !== undefined) {
      const rank = rankOf(fact, options.liveRank);
      // "As of chapter X" includes facts anchored exactly at X; it stops only
      // AFTER the target chapter. `stopRank` is therefore exclusive of later
      // chapters (see ContinuityService.stateAsOf for exact semantics).
      if (rank > stopRank) continue;
    }
    const key = stateKey(fact);
    state.set(key, {
      predicate: fact.predicate,
      value: fact.value,
      relatedLabel: fact.relatedLabel,
      fact,
    });
  }
  return state;
}

/** Deterministic key for a subject+predicate state slot. */
export function stateKey(fact: Pick<ContinuityFact, 'subjectType' | 'subjectId' | 'subjectLabel' | 'predicate'>): string {
  const subject = fact.subjectId ?? `label:${fact.subjectLabel.toLowerCase()}`;
  return `${fact.subjectType}:${subject}:${fact.predicate}`;
}
