/**
 * Bundling entry for P7 verification.
 *
 * Re-exports exactly the P7 modules the verification script exercises. Only
 * PURE / injectable modules are re-exported: the Services are constructed in the
 * script with injected fake repositories/collaborators, so no IndexedDB is used.
 *
 * The `@/` alias is avoided inside the schemas (they import relatively), and the
 * Services use `@/...` imports — the bundler's `root` is the project root, so
 * the alias resolves the same way it does for the app build.
 */
export {
  KnowledgeEntrySchema,
  EvidenceSchema,
  deriveSearchText,
  buildSourceKey,
  KNOWLEDGE_ENTRY_KINDS,
  KNOWLEDGE_SOURCES,
} from '../../src/schemas/knowledge';
export {
  ContinuityFactSchema,
  compareFacts,
  reconstructState,
  stateKey,
  CONTINUITY_PREDICATES,
  CONTINUITY_SUBJECT_TYPES,
} from '../../src/schemas/continuity';
export { AnalysisFindingSchema, ANALYSIS_CATEGORIES, ANALYSIS_STATUSES, ANALYSIS_ORIGINS } from '../../src/schemas/analysis';
export { KnowledgeService } from '../../src/services/knowledge-service';
export { ContinuityService } from '../../src/services/continuity-service';
export { AnalysisService } from '../../src/services/analysis-service';
