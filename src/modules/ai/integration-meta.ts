import type { BadgeTone } from '@/components/ui';
import type { ConflictStrategy, IntegrationStatus, IntegrationTargetType } from '@/types';

/**
 * Presentation metadata for the Project Integration page (P8 Batch 5).
 *
 * Kept in the UI layer: the schema owns the VALUES, this owns how they READ.
 * Typed as exhaustive `Record`s so adding a new enum member / strategy is a
 * compile error here — the UI can never silently drift from the domain.
 */

export const TARGET_TYPE_META: Record<IntegrationTargetType, { label: string; description: string }> = {
  character: { label: 'Character', description: 'Written to the Characters panel.' },
  'world-section': { label: 'World section', description: "Appended to the project's World Building." },
  'knowledge-entry': { label: 'Knowledge entry', description: 'Indexed into the Knowledge Base.' },
  // Reserved target types that Project Integration never routes to (P8 Batch 5
  // only writes the three above). They must still be described exhaustively so
  // the map can never drift from the schema's enum.
  'continuity-fact': { label: 'Continuity fact', description: 'Recorded in the Continuity log (not written by integration).' },
  chapter: { label: 'Chapter', description: 'A manuscript chapter (not written by integration).' },
  scene: { label: 'Scene', description: 'A manuscript scene (not written by integration).' },
};

export const INTEGRATION_STATUS_META: Record<IntegrationStatus, { label: string; tone: BadgeTone }> = {
  'not-applied': { label: 'Not applied', tone: 'neutral' },
  applied: { label: 'Applied', tone: 'success' },
  conflict: { label: 'Conflict', tone: 'warning' },
};

/**
 * Per-field conflict strategy copy shown to the user. Every strategy is
 * explained in plain language so the consequence of a choice is unambiguous.
 * `keep-existing` is the conservative default (never overwrites).
 */
export const STRATEGY_META: Record<ConflictStrategy, { label: string; help: string; tone: BadgeTone }> = {
  'keep-existing': {
    label: 'Keep existing',
    help: 'Preserve the current project value. Nothing is overwritten.',
    tone: 'neutral',
  },
  'use-extracted': {
    label: 'Use extracted',
    help: 'Replace the current value with the extracted value.',
    tone: 'accent',
  },
  'fill-empty-only': {
    label: 'Fill if empty',
    help: 'Only write the extracted value where the current value is empty.',
    tone: 'info',
  },
};

/** Human label for an entity field name, falling back to the raw field. */
const FIELD_LABELS: Record<string, string> = {
  summary: 'Summary',
  background: 'Background',
  tags: 'Tags',
  content: 'Content',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

