/**
 * Story-analysis domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/analysis` via `z.infer`.
 */
export type {
  AnalysisFinding,
  AnalysisCategory,
  AnalysisSeverity,
  AnalysisStatus,
  AnalysisOrigin,
} from '@/schemas/analysis';
export {
  ANALYSIS_CATEGORIES,
  ANALYSIS_SEVERITIES,
  ANALYSIS_STATUSES,
  ANALYSIS_ORIGINS,
} from '@/schemas/analysis';
