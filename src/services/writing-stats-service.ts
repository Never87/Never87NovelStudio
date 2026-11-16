import { now, localDateKey, localDateKeyDaysAgo } from '@/utils/date';
import { createWritingActivityId } from '@/utils/id';
import type { NovelProject } from '@/types';
import type { WritingActivity } from '@/schemas/writing-activity';
import type { WritingGoal } from '@/schemas/writing-goal';
import { ProjectServiceError } from './project-service';
import { WritingGoalService } from './writing-goal-service';
import type { WritingActivityRepository } from '@/repositories/writing-activity-repository';
import { WritingActivityRepository as ActivityRepository } from '@/repositories/writing-activity-repository';
import { ProjectRepository } from '@/repositories/project-repository';
import { OutlineRepository } from '@/repositories/outline-repository';
import { ManuscriptRepository } from '@/repositories/manuscript-repository';
import {
  applyWordDelta,
  buildDailyOutputSeries,
  computeBestStreak,
  computeStreak,
  isCompletedChapter,
  type DailyOutput,
} from '@/modules/dashboard/stats';

/**
 * One entry in the Dashboard "Recent Activity" feed. Derived ENTIRELY from real
 * timestamps that already exist (project creation, chapter-draft last-edit,
 * version snapshots) — never fabricated.
 */
export interface RecentActivityEntry {
  id: string;
  /** Event category, mapped to an icon/tone by the UI. */
  kind: 'project-created' | 'chapter-edited' | 'version-saved';
  /** Human-readable primary text, e.g. `Edited “Chapter 1 — Arrival”`. */
  text: string;
  /** Secondary meta, e.g. `1,240 words` or the project title. */
  meta: string;
  /** When the event happened (epoch ms). */
  at: number;
  /** Project the event belongs to (for a future deep link). */
  projectId: string;
}

/** Where "Continue Writing" should send the author. */
export interface ContinueWritingTarget {
  projectId: string;
  projectTitle: string;
  /** Most recently edited chapter of that project (openable in the editor). */
  chapterId: string | null;
  chapterTitle: string | null;
  /** When the project was last edited (for display). */
  updatedAt: number;
}

/** The complete, real dataset the Dashboard renders. */
export interface DashboardStats {
  /** Sum of current manuscript word counts across every project. */
  wordsWritten: number;
  /** Consecutive days with writing output, counting back from today/yesterday. */
  writingStreak: number;
  /** Longest streak in the recorded history (0 when none). */
  bestStreak: number;
  /** Words written today across all projects. */
  todayWords: number;
  /** Words written in the last 7 days across all projects. */
  weekWords: number;
  /** Chapters whose status counts as completed (see `COMPLETED_CHAPTER_STATUSES`). */
  completedChapters: number;
  /** Total chapters across all projects (so the UI can show `x / total`). */
  totalChapters: number;
  /** The active daily goal, or null when none is set. */
  goal: WritingGoal | null;
  /** Last-7-days output series, oldest first. */
  weekSeries: DailyOutput[];
  /** Where the primary "Continue Writing" action should go, or null. */
  continueTarget: ContinueWritingTarget | null;
  /** Real, timestamped recent activity (newest first). */
  recentActivity: RecentActivityEntry[];
  /**
   * True when NO daily history exists yet (the activity ledger has never
   * recorded output). The UI must show an honest empty state for streak/output
   * charts rather than zeros masquerading as data.
   */
  hasActivityHistory: boolean;
}

/** Per-project writing statistics for the Statistics page (Round 1 — Workspace). */
export interface ProjectStatistics {
  projectId: string;
  projectTitle: string;
  /** Current manuscript word count (chapter + scene drafts). */
  wordsWritten: number;
  totalChapters: number;
  completedChapters: number;
  /** Words written in the last 7 days for this project. */
  weekWords: number;
  /** Words written today for this project. */
  todayWords: number;
  /** Last-7-days output series for this project (oldest first). */
  weekSeries: DailyOutput[];
  /** True when this project has any recorded activity history. */
  hasActivityHistory: boolean;
}

/** Workspace-wide statistics snapshot for the Statistics page. */
export interface WorkspaceStatistics {
  /** Per-project rows, already sorted by wordsWritten desc. */
  projects: ProjectStatistics[];
  /** Workspace totals (sum of the per-project rows + streak). */
  totals: {
    projects: number;
    wordsWritten: number;
    totalChapters: number;
    completedChapters: number;
    todayWords: number;
    weekWords: number;
    writingStreak: number;
    bestStreak: number;
  };
  /** Workspace-wide last-7-days output series (oldest first). */
  weekSeries: DailyOutput[];
  /** Workspace-wide last-30-days output series (oldest first). */
  monthSeries: DailyOutput[];
  /** True when the workspace has any recorded activity history. */
  hasActivityHistory: boolean;
  /** Active daily goal (shared with Dashboard), or null. */
  goal: WritingGoal | null;
}

/**
 * Business layer that assembles Dashboard statistics from REAL data (Dashboard
 * fix — Round 1).
 *
 * It reads projects, chapters and manuscripts through the existing repositories
 * and the writing-activity ledger, then delegates the non-trivial maths
 * (streak, weekly series, "completed") to the pure helpers in
 * `modules/dashboard/stats.ts`. It owns no display state and never fabricates
 * numbers: an empty workspace yields genuine zeros / nulls / empty lists.
 *
 * `recordWordDelta` is the single write path used by `ManuscriptService` to
 * append to the activity ledger as prose is saved, so the statistics are always
 * derived from what was actually written.
 */
export class WritingStatsService {
  private readonly activityRepository: WritingActivityRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly outlineRepository: OutlineRepository;
  private readonly manuscriptRepository: ManuscriptRepository;
  private readonly goalService: WritingGoalService;

  constructor(
    activityRepository: WritingActivityRepository = new ActivityRepository(),
    projectRepository: ProjectRepository = new ProjectRepository(),
    outlineRepository: OutlineRepository = new OutlineRepository(),
    manuscriptRepository: ManuscriptRepository = new ManuscriptRepository(),
    goalService: WritingGoalService = new WritingGoalService(),
  ) {
    this.activityRepository = activityRepository;
    this.projectRepository = projectRepository;
    this.outlineRepository = outlineRepository;
    this.manuscriptRepository = manuscriptRepository;
    this.goalService = goalService;
  }

  /* ------------------------------ Recording ------------------------------ */

  /**
   * Records `wordDelta` (net change in a project's manuscript word count) into
   * today's activity row for `projectId`.
   *
   * Idempotent per day: each call adds to today's running total (clamped at 0),
   * creating the row on first write. A zero delta is a no-op. This is called by
   * the manuscript save path AFTER the prose is persisted, so the ledger can
   * never claim words that were not actually saved.
   */
  async recordWordDelta(projectId: string, wordDelta: number): Promise<void> {
    if (wordDelta === 0 || !Number.isFinite(wordDelta)) return;
    try {
      const dateKey = localDateKey(now());
      const existing = await this.activityRepository.getByProjectAndDate(projectId, dateKey);
      const timestamp = now();
      if (existing) {
        const next: WritingActivity = {
          ...existing,
          wordsWritten: applyWordDelta(existing.wordsWritten, wordDelta),
          updatedAt: timestamp,
        };
        await this.activityRepository.put(next);
      } else {
        const row: WritingActivity = {
          id: createWritingActivityId(),
          projectId,
          dateKey,
          wordsWritten: applyWordDelta(0, wordDelta),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await this.activityRepository.create(row);
      }
    } catch (error) {
      throw this.wrap(error, `Failed to record writing activity for project "${projectId}"`);
    }
  }

  /* -------------------------------- Reading ------------------------------ */

  /**
   * Assembles the full Dashboard statistics snapshot.
   *
   * @param recentLimit Max number of recent-activity entries to return.
   * @param reference  The "now" instant (injectable for deterministic tests).
   */
  async getDashboardStats(recentLimit = 8, reference: number = now()): Promise<DashboardStats> {
    try {
      const projects = await this.projectRepository.getAll();

      // Per-project reads run in parallel; project counts are small (a personal
      // workspace), and each query is index-backed by `projectId`.
      const perProject = await Promise.all(
        projects.map(async (project) => {
          const [chapters, chapterDrafts, sceneDrafts] = await Promise.all([
            this.outlineRepository.listChaptersByProject(project.id),
            this.manuscriptRepository.listChapterDraftsByProject(project.id),
            this.manuscriptRepository.listSceneDraftsByProject(project.id),
          ]);
          return { project, chapters, chapterDrafts, sceneDrafts };
        }),
      );

      // --- Words Written: unified count = current manuscript prose across all
      //     projects (chapter drafts + scene drafts). This matches
      //     `ManuscriptService.countProjectWords` and the book-assembly total,
      //     so every surface reports the SAME number for the same data.
      let wordsWritten = 0;
      let totalChapters = 0;
      let completedChapters = 0;
      for (const { chapters, chapterDrafts, sceneDrafts } of perProject) {
        wordsWritten += chapterDrafts.reduce((sum, d) => sum + d.wordCount, 0);
        wordsWritten += sceneDrafts.reduce((sum, d) => sum + d.wordCount, 0);
        totalChapters += chapters.length;
        completedChapters += chapters.filter((c) => isCompletedChapter(c.status)).length;
      }

      // --- Activity ledger: read a generous window (last 365 days) for the
      //     streak + weekly chart. An empty ledger ⇒ honest zero streak.
      const fromKey = localDateKeyDaysAgo(364, reference);
      const toKey = localDateKey(reference);
      const activityRows = await this.activityRepository.listByDateRange(fromKey, toKey);
      const hasActivityHistory = activityRows.some((row) => row.wordsWritten > 0);

      const weekSeries = buildDailyOutputSeries(activityRows, 7, reference);
      const todayKey = localDateKey(reference);
      const todayWords = weekSeries.find((d) => d.dateKey === todayKey)?.words ?? 0;
      const weekWords = weekSeries.reduce((sum, d) => sum + d.words, 0);

      const totalsByDay = new Map<string, number>();
      for (const row of activityRows) {
        totalsByDay.set(row.dateKey, (totalsByDay.get(row.dateKey) ?? 0) + row.wordsWritten);
      }
      const writingStreak = hasActivityHistory ? computeStreak(totalsByDay, reference) : 0;
      const bestStreak = computeBestStreak(activityRows);

      // --- Continue Writing: the project with the most recent edit, and within
      //     it the chapter draft with the latest `updatedAt`. Real data only.
      const continueTarget = this.pickContinueTarget(perProject);

      // --- Recent Activity: real, timestamped events from existing data. ---
      const recentActivity = this.collectRecentActivity(perProject, recentLimit);

      const goal = await this.goalService.getGlobalGoal();

      return {
        wordsWritten,
        writingStreak,
        bestStreak,
        todayWords,
        weekWords,
        completedChapters,
        totalChapters,
        goal,
        weekSeries,
        continueTarget,
        recentActivity,
        hasActivityHistory,
      };
    } catch (error) {
      throw this.wrap(error, 'Failed to compute dashboard statistics');
    }
  }

  /**
   * Chooses the "continue writing" target: the project/chapter the author most
   * recently WORKED ON, across ALL projects.
   *
   * The recency signal is each project's latest chapter-draft `updatedAt` (the
   * moment prose was actually saved), falling back to the project's own
   * `updatedAt` when chapters exist but were never drafted.
   *
   * Projects are compared by that per-project recency — NOT by the list order.
   * `ProjectRepository.getAll()` sorts by `project.updatedAt`, but editing a
   * chapter draft does not touch the project row, so relying on that order
   * would send the author to a newer-created project they never wrote in
   * instead of the one they just edited. Returns null when no project has any
   * chapters.
   */
  private pickContinueTarget(
    perProject: Array<{
      project: NovelProject;
      chapters: Awaited<ReturnType<OutlineRepository['listChaptersByProject']>>;
      chapterDrafts: Awaited<ReturnType<ManuscriptRepository['listChapterDraftsByProject']>>;
    }>,
  ): ContinueWritingTarget | null {
    let best: {
      project: NovelProject;
      chapters: Awaited<ReturnType<OutlineRepository['listChaptersByProject']>>;
      mostRecentDraft: Awaited<ReturnType<ManuscriptRepository['listChapterDraftsByProject']>>[number] | null;
      lastActivityAt: number;
    } | null = null;

    for (const entry of perProject) {
      // Only a project with chapters can be "continued".
      if (entry.chapters.length === 0) continue;
      const mostRecentDraft =
        [...entry.chapterDrafts].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
      // A real prose edit is the strongest signal; otherwise fall back to the
      // project row's own updatedAt (e.g. outline edits with no draft yet).
      const lastActivityAt = mostRecentDraft
        ? Math.max(mostRecentDraft.updatedAt, entry.project.updatedAt)
        : entry.project.updatedAt;
      if (!best || lastActivityAt > best.lastActivityAt) {
        best = { ...entry, mostRecentDraft, lastActivityAt };
      }
    }

    if (!best) return null;

    const { project, chapters, mostRecentDraft, lastActivityAt } = best;
    // Most recently edited chapter draft (by updatedAt) wins; fall back to the
    // first chapter in outline order when nothing has been written yet.
    const chapterId = mostRecentDraft ? mostRecentDraft.ownerId : chapters[0].id;
    const chapter = chapters.find((c) => c.id === chapterId) ?? null;

    return {
      projectId: project.id,
      projectTitle: project.title,
      chapterId,
      chapterTitle: chapter?.title ?? null,
      updatedAt: lastActivityAt,
    };
  }

  /**
   * Builds the recent-activity feed from REAL timestamps only:
   *   - project creation (`project.createdAt`),
   *   - chapter-draft last edit (`chapterDraft.updatedAt`) — the most reliable
   *     "you edited this chapter at T" signal that exists today,
   *   - (implicitly) the project's own `updatedAt` is NOT used as a proxy for
   *     unrelated events; we only surface the concrete sources above.
   *
   * Events are merged, sorted newest-first and capped at `limit`.
   */
  private collectRecentActivity(
    perProject: Array<{
      project: NovelProject;
      chapters: Awaited<ReturnType<OutlineRepository['listChaptersByProject']>>;
      chapterDrafts: Awaited<ReturnType<ManuscriptRepository['listChapterDraftsByProject']>>;
    }>,
    limit: number,
  ): RecentActivityEntry[] {
    const events: RecentActivityEntry[] = [];

    for (const { project, chapters, chapterDrafts } of perProject) {
      // Project creation — a real, discrete event.
      events.push({
        id: `created:${project.id}`,
        kind: 'project-created',
        text: `Created project “${project.title}”`,
        meta: '',
        at: project.createdAt,
        projectId: project.id,
      });

      // Chapter edits — each draft's last-write timestamp is a real edit event.
      // Only drafts with actual content are surfaced (an empty draft opened but
      // never typed into is not "activity").
      const chapterTitleById = new Map(chapters.map((c) => [c.id, c.title] as const));
      for (const draft of chapterDrafts) {
        if (draft.wordCount <= 0 || draft.updatedAt <= draft.createdAt) continue;
        const title = chapterTitleById.get(draft.ownerId) ?? 'a chapter';
        events.push({
          id: `edited:${draft.id}`,
          kind: 'chapter-edited',
          text: `Edited “${title}”`,
          meta: `${draft.wordCount.toLocaleString()} words`,
          at: draft.updatedAt,
          projectId: project.id,
        });
      }
    }

    return events.sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
  }

  /**
   * Builds per-project and workspace statistics for the Statistics page.
   *
   * Uses the SAME real sources as the Dashboard (chapter/scene drafts + the
   * activity ledger) so every surface reports identical numbers.
   *
   * @param reference The "now" instant (injectable for deterministic tests).
   */
  async getWorkspaceStatistics(reference: number = now()): Promise<WorkspaceStatistics> {
    try {
      const projects = await this.projectRepository.getAll();

      const fromKey = localDateKeyDaysAgo(364, reference);
      const toKey = localDateKey(reference);
      const activityRows = await this.activityRepository.listByDateRange(fromKey, toKey);
      const hasActivityHistory = activityRows.some((row) => row.wordsWritten > 0);

      const rowsByProject = new Map<string, WritingActivity[]>();
      for (const row of activityRows) {
        const list = rowsByProject.get(row.projectId) ?? [];
        list.push(row);
        rowsByProject.set(row.projectId, list);
      }

      const todayKey = localDateKey(reference);

      const perProject: ProjectStatistics[] = await Promise.all(
        projects.map(async (project) => {
          const [chapters, chapterDrafts, sceneDrafts] = await Promise.all([
            this.outlineRepository.listChaptersByProject(project.id),
            this.manuscriptRepository.listChapterDraftsByProject(project.id),
            this.manuscriptRepository.listSceneDraftsByProject(project.id),
          ]);
          const wordsWritten =
            chapterDrafts.reduce((sum, d) => sum + d.wordCount, 0) +
            sceneDrafts.reduce((sum, d) => sum + d.wordCount, 0);
          const projectRows = rowsByProject.get(project.id) ?? [];
          const weekSeries = buildDailyOutputSeries(projectRows, 7, reference);
          return {
            projectId: project.id,
            projectTitle: project.title,
            wordsWritten,
            totalChapters: chapters.length,
            completedChapters: chapters.filter((c) => isCompletedChapter(c.status)).length,
            weekWords: weekSeries.reduce((sum, d) => sum + d.words, 0),
            todayWords: weekSeries.find((d) => d.dateKey === todayKey)?.words ?? 0,
            weekSeries,
            hasActivityHistory: projectRows.some((row) => row.wordsWritten > 0),
          };
        }),
      );

      perProject.sort((a, b) => b.wordsWritten - a.wordsWritten);

      const weekSeries = buildDailyOutputSeries(activityRows, 7, reference);
      const monthSeries = buildDailyOutputSeries(activityRows, 30, reference);

      const totalsByDay = new Map<string, number>();
      for (const row of activityRows) {
        totalsByDay.set(row.dateKey, (totalsByDay.get(row.dateKey) ?? 0) + row.wordsWritten);
      }

      const totals = {
        projects: projects.length,
        wordsWritten: perProject.reduce((sum, p) => sum + p.wordsWritten, 0),
        totalChapters: perProject.reduce((sum, p) => sum + p.totalChapters, 0),
        completedChapters: perProject.reduce((sum, p) => sum + p.completedChapters, 0),
        todayWords: weekSeries.find((d) => d.dateKey === todayKey)?.words ?? 0,
        weekWords: weekSeries.reduce((sum, d) => sum + d.words, 0),
        writingStreak: hasActivityHistory ? computeStreak(totalsByDay, reference) : 0,
        bestStreak: computeBestStreak(activityRows),
      };

      const goal = await this.goalService.getGlobalGoal();

      return { projects: perProject, totals, weekSeries, monthSeries, hasActivityHistory, goal };
    } catch (error) {
      throw this.wrap(error, 'Failed to compute workspace statistics');
    }
  }

  private wrap(error: unknown, message: string): Error {
    if (error instanceof ProjectServiceError) return error;
    return new ProjectServiceError(message, error);
  }
}

