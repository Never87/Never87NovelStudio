import type { BadgeTone } from '@/components/ui';
import type { ProjectStatus } from '@/types';

/**
 * Presentation metadata for project statuses.
 *
 * Keys are constrained to the real `ProjectStatus` union, so adding or
 * renaming a status in the schema causes a type error here — the UI can never
 * silently fall out of sync with the data model. Labels/tones are view-only
 * concerns and deliberately live in the UI layer, not in the schema.
 */
export const PROJECT_STATUS_META: Record<ProjectStatus, { label: string; tone: BadgeTone }> = {
  planning: { label: 'Planning', tone: 'info' },
  writing: { label: 'Writing', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

/** Two-letter avatar initials derived from a project title. */
export function projectInitials(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** Formats a Unix-ms timestamp as a short absolute date, e.g. "12 Mar 2025". */
export function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp < 0) return '—';
  return new Date(timestamp).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
