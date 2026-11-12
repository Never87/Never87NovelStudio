import type { BadgeTone } from '@/components/ui';
import type { ChapterStatus, ScenePurpose, SceneStatus } from '@/types';
import { CHAPTER_STATUSES, SCENE_PURPOSES, SCENE_STATUSES } from '@/types';

/**
 * Presentation metadata for the outline & scene modules.
 *
 * Keys are constrained to the real schema unions, so a change to the data
 * model surfaces here as a type error instead of a silently missing label.
 */
export const CHAPTER_STATUS_META: Record<ChapterStatus, { label: string; tone: BadgeTone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  drafting: { label: 'Drafting', tone: 'info' },
  drafted: { label: 'Drafted', tone: 'warning' },
  revised: { label: 'Revised', tone: 'accent' },
  final: { label: 'Final', tone: 'success' },
};

export const SCENE_STATUS_META: Record<SceneStatus, { label: string; tone: BadgeTone }> = {
  planned: { label: 'Planned', tone: 'neutral' },
  drafted: { label: 'Drafted', tone: 'warning' },
  revised: { label: 'Revised', tone: 'accent' },
  final: { label: 'Final', tone: 'success' },
};

export const SCENE_PURPOSE_META: Record<ScenePurpose, { label: string; tone: BadgeTone }> = {
  setup: { label: 'Setup', tone: 'neutral' },
  conflict: { label: 'Conflict', tone: 'danger' },
  reveal: { label: 'Reveal', tone: 'info' },
  'turning-point': { label: 'Turning point', tone: 'accent' },
  resolution: { label: 'Resolution', tone: 'success' },
  interlude: { label: 'Interlude', tone: 'warning' },
};

export { CHAPTER_STATUSES, SCENE_STATUSES, SCENE_PURPOSES };

/** Human label for a chapter position, 1-based. */
export function chapterLabel(order: number): string {
  return `Chapter ${order + 1}`;
}

/** Sum of planned scene word targets. */
export function totalTargetWords(targets: Array<number | undefined>): number {
  return targets.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** Compact word count, e.g. 12500 -> "12.5k". */
export function formatWords(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(value);
}
