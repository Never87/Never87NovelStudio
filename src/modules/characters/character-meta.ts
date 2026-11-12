import type { BadgeTone } from '@/components/ui';
import type { CharacterRole, CharacterStatus } from '@/types';
import { CHARACTER_ROLES, CHARACTER_STATUSES } from '@/types';

/**
 * Presentation metadata for characters.
 *
 * Keys are constrained to the real unions, so adding/renaming a role or status
 * in the schema causes a type error here — the UI can never silently drift.
 */
export const CHARACTER_ROLE_META: Record<CharacterRole, { label: string; tone: BadgeTone }> = {
  protagonist: { label: 'Protagonist', tone: 'accent' },
  antagonist: { label: 'Antagonist', tone: 'danger' },
  supporting: { label: 'Supporting', tone: 'info' },
  minor: { label: 'Minor', tone: 'neutral' },
};

export const CHARACTER_STATUS_META: Record<CharacterStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  deceased: { label: 'Deceased', tone: 'neutral' },
  missing: { label: 'Missing', tone: 'warning' },
  unused: { label: 'Unused', tone: 'neutral' },
};

export { CHARACTER_ROLES, CHARACTER_STATUSES };

/** Two-letter initials derived from a character name, for the avatar chip. */
export function characterInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const words = trimmed.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
