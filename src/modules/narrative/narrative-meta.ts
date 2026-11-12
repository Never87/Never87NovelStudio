import type { BadgeTone } from '@/components/ui';
import type { NarrativeStatus, NarrativeStructure } from '@/types';
import { NARRATIVE_STATUSES, NARRATIVE_STRUCTURES } from '@/types';

/**
 * Presentation metadata for narrative planning.
 *
 * Keys are constrained to the real unions, so adding/renaming a structure or
 * status in the schema causes a type error here — the UI can never silently
 * drift from the data model.
 */
export const NARRATIVE_STRUCTURE_META: Record<
  NarrativeStructure,
  { label: string; description: string }
> = {
  'three-act': { label: 'Three-Act', description: 'Setup, confrontation, resolution.' },
  'four-act': { label: 'Four-Act', description: 'Adds a mid-story midpoint reversal.' },
  'hero-journey': { label: 'Hero’s Journey', description: 'Departure, initiation, return.' },
  'save-the-cat': { label: 'Save the Cat', description: 'Fifteen-beat beat sheet.' },
  kishotenketsu: { label: 'Kishōtenketsu', description: 'Introduction, development, twist, conclusion.' },
  'seven-point': { label: 'Seven-Point', description: 'Hook to resolution in seven beats.' },
  custom: { label: 'Custom', description: 'A structure of your own design.' },
};

export const NARRATIVE_STATUS_META: Record<NarrativeStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  'in-progress': { label: 'In progress', tone: 'info' },
  locked: { label: 'Locked', tone: 'success' },
};

export { NARRATIVE_STATUSES, NARRATIVE_STRUCTURES };

/**
 * Starter beats for a structure. Used only as a convenience when a user asks
 * for a preset; nothing is written until they save.
 */
export const STRUCTURE_BEAT_PRESETS: Record<NarrativeStructure, string[]> = {
  'three-act': ['Setup', 'Inciting Incident', 'First Plot Point', 'Midpoint', 'Second Plot Point', 'Climax', 'Resolution'],
  'four-act': ['Setup', 'Inciting Incident', 'First Plot Point', 'First Pinch', 'Midpoint', 'Second Pinch', 'Second Plot Point', 'Climax', 'Resolution'],
  'hero-journey': ['Ordinary World', 'Call to Adventure', 'Refusal', 'Meeting the Mentor', 'Crossing the Threshold', 'Tests & Allies', 'Approach', 'Ordeal', 'Reward', 'The Road Back', 'Resurrection', 'Return with the Elixir'],
  'save-the-cat': ['Opening Image', 'Theme Stated', 'Set-Up', 'Catalyst', 'Debate', 'Break into Two', 'B Story', 'Fun and Games', 'Midpoint', 'Bad Guys Close In', 'All Is Lost', 'Dark Night of the Soul', 'Break into Three', 'Finale', 'Final Image'],
  kishotenketsu: ['Ki — Introduction', 'Shō — Development', 'Ten — Twist', 'Ketsu — Conclusion'],
  'seven-point': ['Hook', 'Plot Turn 1', 'Pinch 1', 'Midpoint', 'Pinch 2', 'Plot Turn 2', 'Resolution'],
  custom: [],
};

/** Evenly spaced positions (0–100) for a list of preset beat titles. */
export function presetBeatPositions(count: number): number[] {
  if (count <= 1) return count === 1 ? [50] : [];
  return Array.from({ length: count }, (_, index) => Math.round((index / (count - 1)) * 100));
}
