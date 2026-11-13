/**
 * Knowledge Base domain types.
 *
 * Re-exports only — every type originates from the Zod schemas in
 * `@/schemas/knowledge` via `z.infer`.
 */
export type {
  KnowledgeEntry,
  KnowledgeEntryKind,
  KnowledgeSource,
  KnowledgeSourceRef,
  Evidence,
} from '@/schemas/knowledge';
export {
  KNOWLEDGE_ENTRY_KINDS,
  KNOWLEDGE_SOURCES,
  buildSourceKey,
  deriveSearchText,
} from '@/schemas/knowledge';
