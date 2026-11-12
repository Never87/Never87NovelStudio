import {
  computeTextStats,
  excerpt,
  splitMarkdownChapters,
  chaptersToMarkdown,
  normaliseChapterHeadings,
} from '@/utils/manuscript-text';
import type { Chapter, Volume } from '@/types';
import { OutlineService } from '@/services/outline-service';
import { ManuscriptService } from '@/services/manuscript-service';

/** One chapter as it will be created by an import (dry-run preview). */
export interface ImportPreviewChapter {
  index: number;
  title: string;
  wordCount: number;
  excerpt: string;
  /** Heading level used in the source (`#`, `##`, or 0 for a heading-less body). */
  level: number;
  /** An existing chapter with the same title in the target volume, if any. */
  existingChapterId: string | null;
}

/** Result of a Markdown import. */
export interface ImportResult {
  volumeId: string;
  createdChapterIds: string[];
  skippedTitles: string[];
  importedWords: number;
}

export interface ImportOptions {
  /** Volume to append the chapters to. */
  volumeId: string;
  /**
   * What to do with a chapter whose title already exists in the volume.
   * `skip` (default) never touches existing prose; `overwrite` replaces it.
   */
  onDuplicate?: 'skip' | 'overwrite';
  /** Optional manual title for a leading untitled chapter. */
  untitledLabel?: string;
}

/**
 * Markdown import/export for the writing layer (P4).
 *
 * Import is deliberately two-step: `previewImport()` returns exactly what would
 * be created (counts, excerpts, duplicate detection) and writes nothing;
 * `importMarkdown()` then performs the write. This mirrors the project's rule
 * that bulk data changes are reviewable before they are applied.
 */
export class ManuscriptTransferService {
  private readonly outlineService: OutlineService;
  private readonly manuscriptService: ManuscriptService;

  constructor(
    outlineService: OutlineService = new OutlineService(),
    manuscriptService: ManuscriptService = new ManuscriptService(),
  ) {
    this.outlineService = outlineService;
    this.manuscriptService = manuscriptService;
  }

  /**
   * Parses Markdown into chapter previews without touching the database.
   *
   * `existing` lets the caller mark duplicates; pass the chapters already
   * present in the target volume.
   */
  previewImport(markdown: string, existing: Chapter[] = [], untitledLabel = 'Untitled chapter'): ImportPreviewChapter[] {
    const parsed = splitMarkdownChapters(markdown);
    const byTitle = new Map(existing.map((chapter) => [normalise(chapter.title), chapter]));

    return parsed.map((chapter, index) => {
      const stats = computeTextStats(chapter.content);
      const title = chapter.title.trim() || `${untitledLabel} ${index + 1}`;
      return {
        index,
        title,
        wordCount: stats.wordCount,
        excerpt: excerpt(stats.plainText),
        level: chapter.level,
        existingChapterId: byTitle.get(normalise(title))?.id ?? null,
      };
    });
  }

  /**
   * Imports a Markdown document as chapters in `volumeId`.
   *
   * Chapter order is appended after existing chapters, and each chapter's prose
   * is written through `ManuscriptService` so counters and revisions are always
   * the ones the editor would have produced.
   */
  async importMarkdown(
    projectId: string,
    volumeId: string,
    markdown: string,
    options: ImportOptions,
  ): Promise<ImportResult> {
    const { onDuplicate = 'skip', untitledLabel = 'Untitled chapter' } = options;

    const volume = await this.requireVolume(projectId, volumeId);
    const existing = await this.outlineService.listChapters(volume.id);
    const byTitle = new Map(existing.map((chapter) => [normalise(chapter.title), chapter]));

    const parsed = splitMarkdownChapters(markdown);
    const createdChapterIds: string[] = [];
    const skippedTitles: string[] = [];
    let importedWords = 0;

    for (let index = 0; index < parsed.length; index += 1) {
      const piece = parsed[index];
      const title = piece.title.trim() || `${untitledLabel} ${index + 1}`;
      const duplicate = byTitle.get(normalise(title));

      if (duplicate && onDuplicate === 'skip') {
        skippedTitles.push(title);
        continue;
      }

      let chapterId: string;
      if (duplicate && onDuplicate === 'overwrite') {
        chapterId = duplicate.id;
      } else {
        const created = await this.outlineService.createChapter(projectId, volumeId, {
          title,
          summary: excerpt(computeTextStats(normaliseChapterHeadings(piece.content)).plainText, 200),
          status: 'planned',
        });
        chapterId = created.id;
        byTitle.set(normalise(title), created);
      }

      // Deeper headings stay inside the chapter; `#`/`##` would split it again.
      const { draft } = await this.manuscriptService.saveChapterDraft(
        projectId,
        chapterId,
        { content: normaliseChapterHeadings(piece.content) },
        { snapshotOnSave: duplicate !== undefined },
      );
      importedWords += draft.wordCount;
      if (!createdChapterIds.includes(chapterId)) createdChapterIds.push(chapterId);
    }

    return { volumeId, createdChapterIds, skippedTitles, importedWords };
  }

  /**
   * Exports a volume's chapters as one Markdown document.
   *
   * Chapter prose is read directly from its manuscript; the heading level is
   * the same `##` used by the importer, so export → import round-trips.
   */
  async exportVolume(projectId: string, volumeId: string): Promise<string> {
    const volume = await this.requireVolume(projectId, volumeId);
    const chapters = await this.outlineService.listChapters(volume.id);

    const pieces: Array<{ title: string; content: string }> = [];
    for (const chapter of chapters) {
      const draft = await this.manuscriptService.getDraft('chapter', chapter.id);
      pieces.push({ title: chapter.title, content: draft?.content ?? '' });
    }
    return chaptersToMarkdown(pieces);
  }

  /** Exports a single chapter's prose as Markdown. */
  async exportChapter(projectId: string, chapterId: string): Promise<string> {
    const chapter = await this.outlineService.getChapter(chapterId);
    if (!chapter) throw new Error(`Chapter "${chapterId}" was not found`);
    if (chapter.projectId !== projectId) {
      throw new Error(`Chapter "${chapterId}" does not belong to project "${projectId}"`);
    }
    const draft = await this.manuscriptService.getDraft('chapter', chapterId);
    return chaptersToMarkdown([{ title: chapter.title, content: draft?.content ?? '' }]);
  }

  private async requireVolume(projectId: string, volumeId: string): Promise<Volume> {
    const outline = await this.outlineService.getOutline(projectId);
    const found = outline.find((entry) => entry.volume.id === volumeId);
    if (!found) {
      throw new Error(`Volume "${volumeId}" was not found in project "${projectId}"`);
    }
    return found.volume;
  }
}

/** Title comparison key: case- and whitespace-insensitive. */
function normalise(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}
