/**
 * Narrative-planning domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/narrative` via `z.infer`. No interfaces are re-declared here.
 */
export type {
  NarrativePlan,
  PlotBeat,
  NarrativeStructure,
  NarrativeStatus,
} from '@/schemas/narrative';
