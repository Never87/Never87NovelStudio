import type { BadgeTone } from '@/components/ui';

/**
 * Presentation metadata for world records.
 *
 * View-only concerns (labels, tones) live in the UI layer, never in the schema.
 */

/** Empty/starter section titles offered when adding a section. */
export const WORLD_SECTION_PRESETS = [
  'Geography',
  'History',
  'Culture',
  'Factions',
  'Magic & Technology',
  'Religion',
  'Economy',
  'Daily Life',
] as const;

/** Tone used to render the world status chip. */
export const WORLD_TONE: BadgeTone = 'accent';

/** Truncates long body text for card previews without cutting mid-word. */
export function preview(text: string, max = 180): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}
