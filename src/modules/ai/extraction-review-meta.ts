import type { BadgeTone } from '@/components/ui';
import type { ExtractionKind, ExtractionOrigin, ExtractionReviewStatus } from '@/types';
import { EXTRACTION_KINDS, EXTRACTION_ORIGINS, EXTRACTION_REVIEW_STATUSES } from '@/types';

/**
 * Presentation metadata for the Extraction Review Center (P8 Batch 4).
 *
 * Labels/tones for the domain enums the reviewer sees. Kept in the UI layer
 * (not the schema): the schema owns the VALUES, this owns how they READ. Typed
 * as exhaustive `Record`s so adding a new enum member is a compile error here —
 * the UI can never silently drift from the domain.
 */

export const REVIEW_STATUS_META: Record<ExtractionReviewStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  merged: { label: 'Merged', tone: 'info' },
};

export const ORIGIN_META: Record<ExtractionOrigin, { label: string; tone: BadgeTone }> = {
  fact: { label: 'From text', tone: 'accent' },
  ai: { label: 'AI', tone: 'info' },
  manual: { label: 'Manual', tone: 'neutral' },
};

export const KIND_LABELS: Record<ExtractionKind, string> = {
  character: 'Character',
  location: 'Location',
  faction: 'Faction',
  rule: 'Rule',
  event: 'Event',
  item: 'Item',
  concept: 'Concept',
  term: 'Term',
  relationship: 'Relationship',
  style: 'Style',
};

export { EXTRACTION_KINDS, EXTRACTION_ORIGINS, EXTRACTION_REVIEW_STATUSES };

/** Formats an advisory confidence in [0,1] as a whole percentage, or "—". */
export function formatConfidence(confidence: number | null): string {
  if (confidence === null || Number.isNaN(confidence)) return '—';
  return `${Math.round(confidence * 100)}%`;
}
