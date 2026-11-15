/**
 * Chapter selection logic (P9 Batch B — Chapter Export).
 *
 * Pure, framework-free helpers for selecting chapters to export. Kept separate
 * from React so the selection rules — canonical order, stale-selection clearing
 * on project/volume change, select-all/clear within a volume, cross-project
 * safety — are unit-testable without a DOM.
 *
 * Canonical order is NOT re-implemented here: callers pass the outline exactly
 * as `OutlineService` / `useOutline` returns it (volumes in project order, each
 * with chapters in `order` query order). These helpers only FILTER and
 * DE-DUPLICATE by that given order; they never re-sort.
 */

import type { VolumeWithChapters } from '@/services';

/** A single selectable chapter row the export UI can render. */
export interface SelectableChapter {
  readonly id: string;
  readonly title: string;
  readonly volumeId: string;
  readonly volumeTitle: string;
  /** Canonical order within its volume (as provided by the outline service). */
  readonly order: number;
  /** Scene count for the chapter (metadata only). */
  readonly sceneCount: number;
}

/**
 * Flattens an outline into selectable rows in CANONICAL order (volumes in their
 * given order, chapters in their given order). No re-sorting.
 */
export function toSelectableChapters(
  outline: readonly VolumeWithChapters[],
  sceneCounts: Record<string, number> = {},
): SelectableChapter[] {
  const rows: SelectableChapter[] = [];
  for (const { volume, chapters } of outline) {
    for (const chapter of chapters) {
      rows.push({
        id: chapter.id,
        title: chapter.title,
        volumeId: volume.id,
        volumeTitle: volume.title,
        order: chapter.order,
        sceneCount: sceneCounts[chapter.id] ?? 0,
      });
    }
  }
  return rows;
}

/** Chapters belonging to a single volume, in canonical order. */
export function chaptersInVolume(
  outline: readonly VolumeWithChapters[],
  volumeId: string,
): string[] {
  if (!volumeId) return [];
  for (const { volume, chapters } of outline) {
    if (volume.id === volumeId) return chapters.map((c) => c.id);
  }
  return [];
}

/**
 * Filters a selection down to ids that still exist in `validIds`, preserving the
 * CANONICAL order of `validIds` (not the order they were selected). This is what
 * guarantees "no stale selection is exported" after a project/volume change and
 * that combined output is always in canonical order.
 */
export function normalizeSelection(
  validIds: readonly string[],
  selected: ReadonlySet<string> | readonly string[],
): string[] {
  const selectedSet = selected instanceof Set ? selected : new Set(selected);
  return validIds.filter((id) => selectedSet.has(id));
}

/**
 * Drops any selected ids that do NOT belong to `allowedIds` (e.g. current
 * volume / project). Returns a new Set. Used when project or volume changes.
 */
export function pruneToAllowed(
  selected: ReadonlySet<string>,
  allowedIds: readonly string[],
): Set<string> {
  const allowed = new Set(allowedIds);
  const next = new Set<string>();
  for (const id of selected) {
    if (allowed.has(id)) next.add(id);
  }
  return next;
}

/** Immutable toggle of a single chapter id. */
export function toggleSelection(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Selection for "Select all in current volume". Replaces the selection with the
 * full set of that volume's chapters (the export is scoped to one volume at a
 * time, so this is the natural meaning of "select all").
 */
export function selectAllInVolume(volumeChapterIds: readonly string[]): Set<string> {
  return new Set(volumeChapterIds);
}

/** Clears the entire selection. */
export function clearSelection(): Set<string> {
  return new Set<string>();
}

/** Result of comparing a selection against the current volume. */
export interface SelectionSummary {
  /** Selected ids that belong to the current volume, in canonical order. */
  readonly effectiveIds: string[];
  /** Selected ids that are NOT in the current volume (would be stale). */
  readonly staleIds: string[];
  readonly count: number;
  readonly allSelected: boolean;
  readonly noneSelected: boolean;
}

/**
 * Summarises a selection against the current volume: which selected ids are
 * actually in scope, which are stale, and select-all state. "allSelected" is
 * only true when there is at least one chapter and every one is selected.
 */
export function summarizeSelection(
  selected: ReadonlySet<string>,
  volumeChapterIds: readonly string[],
): SelectionSummary {
  const volumeSet = new Set(volumeChapterIds);
  const effectiveIds = volumeChapterIds.filter((id) => selected.has(id));
  const staleIds = [...selected].filter((id) => !volumeSet.has(id));
  const allSelected = volumeChapterIds.length > 0 && effectiveIds.length === volumeChapterIds.length;
  return {
    effectiveIds,
    staleIds,
    count: effectiveIds.length,
    allSelected,
    noneSelected: effectiveIds.length === 0,
  };
}
