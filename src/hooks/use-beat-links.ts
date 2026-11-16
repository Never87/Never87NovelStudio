import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter } from '@/types';
import { outlineService } from '@/services';

export interface UseBeatLinksResult {
  /** Chapters grouped by the beat they implement (derived from `Chapter.plotBeatId`). */
  linksByBeat: Map<string, Chapter[]>;
  /** Every chapter of the project, for the reverse-assign picker. */
  chapters: Chapter[];
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  /**
   * Reverse edit: point `chapterId` at `beatId` (or clear it with `null`).
   *
   * Delegates to the SAME `outlineService.updateChapter` the outline uses, so
   * `Chapter.plotBeatId` stays the single source of truth and no second copy is
   * created. Only the link is touched; the rest of the chapter is preserved by
   * the service's partial-update semantics.
   */
  assignChapterToBeat: (chapterId: string, beatId: string | null) => Promise<Chapter>;
  /**
   * Clears dangling beat links after beats are removed from the plan.
   * Returns how many chapters were unlinked.
   */
  unlinkRemovedBeats: (removedBeatIds: Iterable<string>) => Promise<number>;
}

/**
 * Reverse view + reverse editing of the chapter↔plot-beat relationship.
 *
 * The relationship lives ONLY on `Chapter.plotBeatId`. This hook therefore
 * DERIVES the beat→chapters view from the chapter list and performs reverse
 * edits by updating the chapter's link — never by writing anything onto the
 * beat. That keeps a single source of truth and rules out update cycles.
 */
export function useBeatLinks(projectId: string | undefined): UseBeatLinksResult {
  const [linksByBeat, setLinksByBeat] = useState<Map<string, Chapter[]>>(new Map());
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (token: number, id: string | undefined) => {
    if (!id) {
      if (mountedRef.current && token === requestIdRef.current) {
        setLinksByBeat(new Map());
        setChapters([]);
        setLoading(false);
        setError(null);
      }
      return;
    }
    setLoading(true);
    try {
      const [list, links] = await Promise.all([
        outlineService.listProjectChapters(id),
        outlineService.getBeatChapterLinks(id),
      ]);
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setChapters(list);
      setLinksByBeat(links);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || token !== requestIdRef.current) return;
      setError(err);
    } finally {
      if (mountedRef.current && token === requestIdRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current, projectId);
  }, [load, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const assignChapterToBeat = useCallback(
    async (chapterId: string, beatId: string | null): Promise<Chapter> => {
      const updated = await outlineService.updateChapter(chapterId, { plotBeatId: beatId });
      await refresh();
      return updated;
    },
    [refresh],
  );

  const unlinkRemovedBeats = useCallback(
    async (removedBeatIds: Iterable<string>): Promise<number> => {
      if (!projectId) return 0;
      const count = await outlineService.unlinkRemovedBeats(projectId, removedBeatIds);
      await refresh();
      return count;
    },
    [refresh, projectId],
  );

  return {
    linksByBeat,
    chapters,
    loading,
    error,
    refresh,
    assignChapterToBeat,
    unlinkRemovedBeats,
  };
}
