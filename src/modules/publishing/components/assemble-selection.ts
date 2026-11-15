/**
 * Chapter Export assembly composition (P9 Batch B).
 *
 * Composes a single `BookAssemblyModel` from the user's selected chapters by
 * reusing the Batch A `bookAssemblyService.assembleChapter` for each chapter and
 * merging them into one volume — in the SAME canonical order the selection was
 * normalised to. Nothing here reformats prose; the composed model is fed to the
 * unchanged `FormattingPipeline` and writers.
 *
 * Why per-chapter assembly then merge (instead of `assembleBook`):
 *   - The user may select ANY subset of chapters (not whole volumes), so we must
 *     fetch exactly those chapters' prose. `assembleChapter` already resolves a
 *     chapter's authoritative `ChapterDraft` with identical empty-state handling
 *     to `assembleBook`, so there is one retrieval path — we just collect them.
 *   - The merged model keeps the SELECTED order (already canonical), so the
 *     pipeline numbers chapters 1..N over the selection, which is what the user
 *     asked to export.
 */

import { bookAssemblyService } from '@/services';
import type {
  AssemblyChapter,
  AssemblyProjectMetadata,
  AssemblyVolume,
  BookAssemblyModel,
} from '@/modules/publishing';

/**
 * Assembles the selected chapters of `projectId` into ONE `BookAssemblyModel`.
 *
 * @param projectId  The project the chapters belong to.
 * @param chapterIds Chapter ids in CANONICAL order (callers pass the result of
 *                   `normalizeSelection`, never a Set's iteration order).
 * @param volume     Id + title to record for the merged volume (the preset
 *                   decides whether that volume heading is emitted).
 * @param projectMetadata Project metadata (supplied by the caller from the
 *                   already-loaded project) so the merged model carries the
 *                   right title/author without an extra full-book assembly.
 * @throws {Error} if a chapter does not belong to the project (propagated from
 *   the Batch A service's `BookAssemblyError`).
 */
export async function assembleSelectedChapters(
  projectId: string,
  chapterIds: readonly string[],
  volume: { id: string; title: string },
  projectMetadata: AssemblyProjectMetadata,
): Promise<BookAssemblyModel> {
  const chapters: AssemblyChapter[] = [];
  let totalWords = 0;

  // Assemble one by one (each reuses the shared per-chapter retrieval path).
  for (const chapterId of chapterIds) {
    const single = await bookAssemblyService.assembleChapter(projectId, chapterId, {
      includeSceneCounts: true,
    });
    const chapter = single.volumes[0]?.chapters[0];
    if (!chapter) continue; // defensive — should never happen
    chapters.push(chapter);
    totalWords += chapter.stats.wordCount;
  }

  const mergedVolume: AssemblyVolume = {
    id: volume.id,
    title: volume.title,
    summary: '',
    chapters,
  };

  return {
    project: projectMetadata,
    volumes: [mergedVolume],
    totalChapters: chapters.length,
    totalWords,
  };
}

/**
 * Projects the publishing-relevant metadata from a loaded project, so the page
 * can pass it in without a second assembly. Mirrors the Batch A mapping exactly.
 */
export function projectMetadataFrom(project: {
  id: string;
  title: string;
  description: string;
  genre: readonly string[];
  tags: readonly string[];
  settings: { author?: string; language?: string };
}): AssemblyProjectMetadata {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    author: project.settings.author ?? '',
    language: project.settings.language ?? '',
    genre: project.genre,
    tags: project.tags,
  };
}

