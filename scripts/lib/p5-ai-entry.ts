/**
 * Bundling entry for P5 verification.
 *
 * Re-exports exactly the modules the P5 script exercises. Kept under
 * `scripts/lib` so the bundler (`p4-bundler.cjs`) can import it as a normal
 * project file. The `@/` alias is resolved by Vite because `root` is the
 * project root.
 */
export { OpenAiCompatibleAdapter, applyCustomHeaders } from '../../src/services/ai/adapters/openai-adapter';
export { AnthropicAdapter } from '../../src/services/ai/adapters/anthropic-adapter';
export { GeminiAdapter } from '../../src/services/ai/adapters/gemini-adapter';
export { AiError } from '../../src/services/ai/ai-errors';
export { diffWords, tokenizeWords, isIdentical } from '../../src/services/ai/text-diff';
export { redactSecrets, maskApiKey, redactKnownPatterns, redactForError } from '../../src/services/ai/redaction';
export { captureInsertAnchor, validateAnchor } from '../../src/modules/ai/insert-anchor';
