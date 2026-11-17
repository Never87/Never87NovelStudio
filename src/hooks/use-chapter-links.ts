import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chapter, Character, KnowledgeEntry } from '@/types';
import type { SubjectState } from '@/services';
import { characterService, continuityService, knowledgeService, outlineService } from '@/services';

/** How a chapter references (or is referenced by) an entity. */
export interface LinkedEntity {
  /** The knowledge entry that represents the entity. */
  entry: KnowledgeEntry;
  /** How the link was established. */
  via: 'character-link' | 'evidence' | 'mention';
  /** Number of mentions found in the chapter prose (for `mention`/`evidence`). */
  mentions: number;
}

export interface ChapterLinks {
  /** Characters explicitly attached to this chapter (outline `characterIds`). */
  linkedCharacters: Character[];
  /** Knowledge entries whose evidence cites this chapter. */
  evidenceEntries: KnowledgeEntry[];
  /** Knowledge entries whose title appears in the chapter prose. */
  mentionedEntries: LinkedEntity[];
  /** Reverse index: for each character id, the titles of chapters mentioning it. */
  characterAppearances: Array<{ character: Character; chapterTitles: string[] }>;
  /** Reconstructed continuity state as of (and including) this chapter. */
  continuityState: SubjectState[];
}

export type ChapterLinksStatus = 'idle' | 'loading' | 'success' | 'error';

export interface UseChapterLinksResult {
  links: ChapterLinks | null;
  status: ChapterLinksStatus;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
}

const EMPTY: ChapterLinks = {
  linkedCharacters: [],
  evidenceEntries: [],
  mentionedEntries: [],
  characterAppearances: [],
  continuityState: [],
};

/**
 * Computes the two-way links between a chapter and the project's story entities.
 *
 * This is a READ-ONLY composition of the EXISTING P7/P3/P2 services — it never
 * writes and never introduces a parallel data model:
 *
 *   - Forward (chapter → entities): the outline `characterIds` link (authoritative
 *     character association), knowledge entries whose `evidence[].chapterId`
 *     cites this chapter, and knowledge entries whose title is mentioned in the
 *     chapter prose.
 *   - Reverse (entities → chapters): for each character, which chapters list it
 *     via `characterIds` OR whose prose mentions it — so clicking a character
 *     reveals every chapter it appears in, and inspecting a chapter reveals its
 *     cast. Bidirectional by construction (both views derive from the same rows).
 *   - Continuity: `continuityService.stateAsOf(projectId, chapterId)` — the same
 *     event-sourced reconstruction used by the Continuity manager, not a copy.
 *
 * `prose` is the chapter's plain manuscript text (passed by the editor, already
 * debounced upstream); when absent, mention detection is skipped but outline and
 * evidence links still resolve.
 */
export function useChapterLinks(
  projectId: string | undefined,
  chapter: Chapter | null | undefined,
  prose: string,
): UseChapterLinksResult {
  const [links, setLinks] = useState<ChapterLinks | null>(null);
  const [status, setStatus] = useState<ChapterLinksStatus>('idle');
  const [error, setError] = useState<unknown>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (token: number) => {
      if (!projectId || !chapter) {
        if (mountedRef.current && token === requestIdRef.current) {
          setLinks(null);
          setStatus('idle');
        }
        return;
      }
      setStatus('loading');
      try {
        const [chapters, characters, entries, continuityState] = await Promise.all([
          outlineService.listProjectChapters(projectId),
          characterService.listCharacters(projectId),
          knowledgeService.listEntries(projectId),
          continuityService.stateAsOf(projectId, chapter.id).catch(() => [] as SubjectState[]),
        ]);

        if (!mountedRef.current || token !== requestIdRef.current) return;

        const characterById = new Map(characters.map((c) => [c.id, c]));
        const haystack = prose.toLowerCase();

        // Mention detection: a knowledge entry "appears" when its title (length≥3)
        // occurs in the prose. Character entries are the most useful, but any
        // entity kind is considered so locations/items surface too.
        const mentionCount = (title: string): number => {
          const needle = title.trim().toLowerCase();
          if (needle.length < 3) return 0;
          let count = 0;
          let index = haystack.indexOf(needle);
          while (index !== -1) {
            count += 1;
            index = haystack.indexOf(needle, index + needle.length);
          }
          return count;
        };

        const linkedCharacters = chapter.characterIds
          .map((id) => characterById.get(id))
          .filter((c): c is Character => Boolean(c));

        const evidenceEntries = entries.filter((entry) =>
          entry.evidence.some((ev) => ev.chapterId === chapter.id),
        );

        const mentionedEntries: LinkedEntity[] = [];
        for (const entry of entries) {
          const mentions = mentionCount(entry.title);
          if (mentions > 0) mentionedEntries.push({ entry, via: 'mention', mentions });
        }
        mentionedEntries.sort((a, b) => b.mentions - a.mentions);

        // Reverse index: character → chapters (outline link OR prose mention).
        const characterAppearances = characters
          .map((character) => {
            const chapterTitles: string[] = [];
            for (const ch of chapters) {
              const linked = ch.characterIds.includes(character.id);
              const mentioned = ch.id === chapter.id ? mentionCount(character.name) > 0 : false;
              if (linked || mentioned) chapterTitles.push(ch.title);
            }
            return { character, chapterTitles };
          })
          .filter((row) => row.chapterTitles.length > 0);

        setLinks({
          linkedCharacters,
          evidenceEntries,
          mentionedEntries,
          characterAppearances,
          continuityState,
        });
        setStatus('success');
        setError(null);
      } catch (err) {
        if (!mountedRef.current || token !== requestIdRef.current) return;
        setLinks(EMPTY);
        setStatus('error');
        setError(err);
      }
    },
    [projectId, chapter, prose],
  );

  const refresh = useCallback(async () => {
    requestIdRef.current += 1;
    await load(requestIdRef.current);
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    links,
    status,
    loading: status === 'loading',
    error,
    refresh,
  };
}
