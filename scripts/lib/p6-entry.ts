/**
 * Bundling entry for P6 verification.
 *
 * Re-exports exactly the P6 modules the verification script exercises. The `@/`
 * alias resolves because the bundler's `root` is the project root. Only PURE,
 * browser-free modules are re-exported here — the assembly service's DB-bound
 * collaborators are injected as fakes in the script, so they are NOT imported.
 */
export {
  renderTemplate,
  parsePlaceholders,
  validateTemplate,
  referencedVariableNames,
  normalizeValues,
  PromptRenderError,
} from '../../src/services/ai/prompt-render';
export { estimateTokens, estimateMessagesTokens } from '../../src/services/ai/token-estimator';

/**
 * Pure-ish helpers we want to test directly. The assembly service's dedupe and
 * budget logic is internal, so instead of importing the whole DB-bound service
 * we re-export a small, side-effect-free mirror is NOT acceptable (we must test
 * real code). We therefore export the real service but the script constructs it
 * with injected fake collaborators so no IndexedDB is touched.
 */
export { ContextAssemblyService, ContextAssemblyError } from '../../src/services/context-assembly-service';
export { PromptTemplateService, PromptTemplateError } from '../../src/services/prompt-template-service';
export { ContextManagerService, isReferenceSource } from '../../src/services/context-manager-service';
export { defaultContextConfig } from '../../src/schemas/context';
