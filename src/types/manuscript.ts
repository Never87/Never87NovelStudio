/**
 * Manuscript domain types.
 *
 * Re-exports only — every type originates from the Zod schema in
 * `@/schemas/manuscript` via `z.infer`.
 */
export type { ChapterDraft, SceneDraft, Draft, DraftVersion } from '@/schemas/manuscript';
export type { DraftKind, DraftVersionReason } from '@/schemas/manuscript';
export {
  DRAFT_KINDS,
  DRAFT_VERSION_REASONS,
  MAX_DRAFT_CHARS,
  MAX_VERSIONS_PER_DRAFT,
} from '@/schemas/manuscript';
