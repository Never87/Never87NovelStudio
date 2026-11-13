/**
 * Continuity domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/continuity` via `z.infer`.
 */
export type {
  ContinuityFact,
  ContinuitySubjectType,
  ContinuityPredicate,
  ReconstructedStateValue,
  LiveRankLookup,
} from '@/schemas/continuity';
export {
  CONTINUITY_SUBJECT_TYPES,
  CONTINUITY_PREDICATES,
  compareFacts,
  reconstructState,
  stateKey,
} from '@/schemas/continuity';
