import { useState } from 'react';
import { BookOpen, Flame, FolderKanban, LayoutDashboard, PenLine } from 'lucide-react';
import { Button, PageHeader } from '@/components/ui';
import { useThemeMode } from '@/core/theme/theme';
import { useDashboardStats, useProjects, useWritingGoal } from '@/hooks';
import type { CreateProjectInput, UpdateProjectInput } from '@/services';
import { ProjectsError, ProjectsLoading } from '@/modules/projects/components/ProjectsStates';
import { ProjectFormDialog } from '@/modules/projects/components/ProjectFormDialog';
import { StatCard } from '@/modules/dashboard/components/StatCard';
import { ContinueWritingCard } from '@/modules/dashboard/components/ContinueWritingCard';
import { RecentProjectsCard } from '@/modules/dashboard/components/RecentProjectsCard';
import { ProjectStatusCard } from '@/modules/dashboard/components/ProjectStatusCard';
import { QuickAccessCard } from '@/modules/dashboard/components/QuickAccessCard';
import { WritingGoalCard } from '@/modules/dashboard/components/WritingGoalCard';
import { RecentActivityCard } from '@/modules/dashboard/components/RecentActivityCard';
import { AiStatusCard } from '@/modules/dashboard/components/AiStatusCard';

/**
 * Dashboard — the workspace home.
 *
 * Layout: welcome header, a 4-up stat row, then a two-column workbench
 * (main column 2/3, right rail 1/3) that collapses to a single column below
 * `xl`.
 *
 * Data: EVERYTHING on this page is driven by REAL data — there is no demo
 * content and no "demo data" banner any more.
 *   - Projects (total / recent / status breakdown): `useProjects()`.
 *   - Words Written, Writing Streak, Completed Chapters, Continue Writing,
 *     Recent Activity, and the weekly goal chart: `useDashboardStats()`, which
 *     aggregates real projects/manuscripts plus the persisted writing-activity
 *     ledger (see `WritingStatsService`).
 *   - The daily writing goal: `useWritingGoal()`, the same persisted source the
 *     future Writing Goals page will use.
 *
 * Honest empty states: with no projects / no recorded output, the stat cards
 * show genuine zeros and the cards show "nothing yet" copy — never fabricated
 * figures or fake trends. Trend affordances are only shown when there is real
 * data behind them.
 *
 * Creating a project reuses the shared `ProjectFormDialog`; on success the total
 * and recent lists refresh and the stats snapshot is refetched.
 */
export function DashboardPage() {
  const themeMode = useThemeMode();

  // Real project list — drives Total, Recent and the status breakdown.
  const { projects, initialLoading, error, refresh, createProject } = useProjects();
  // Real aggregate statistics (words, streak, completed chapters, activity…).
  const { stats, refresh: refreshStats } = useDashboardStats();
  // The persisted daily goal (shared source of truth).
  const { goal, setGoal, loading: goalSaving } = useWritingGoal();

  // Create-dialog visibility. Closed by default.
  const [createOpen, setCreateOpen] = useState(false);

  /**
   * Delegates to the hook, which creates the project and refreshes the list.
   * After a successful create we also refetch the stats snapshot so the
   * Continue Writing / activity / counts reflect the new project.
   */
  const handleCreate = async (input: CreateProjectInput | UpdateProjectInput) => {
    await createProject(input as CreateProjectInput);
    await refreshStats();
  };

  // Derived, display-only values. All sourced from real `stats`; `undefined`
  // means "not loaded yet" and is rendered as an ellipsis, never a fake zero.
  const wordsWritten = stats?.wordsWritten;
  const writingStreak = stats?.writingStreak;
  const bestStreak = stats?.bestStreak;
  const completedChapters = stats?.completedChapters;
  const totalChapters = stats?.totalChapters;
  const weekWords = stats?.weekWords;
  const hasActivityHistory = stats?.hasActivityHistory ?? false;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LayoutDashboard className="size-4" />}
        eyebrow="Workspace"
        title="Welcome back, Never87"
        description="Your AI-assisted novel workbench: planning, world building, drafting and analysis in one place."
        actions={
          <>
            <Button variant="secondary" size="sm" disabled title="Available from a project's Writing tab">
              Import Manuscript
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCreateOpen(true)}
              iconLeft={<PenLine className="size-3.5" />}
            >
              New Project
            </Button>
          </>
        }
        toolbar={
          <span className="text-subtle text-2xs">
            Theme: <span className="text-muted font-medium capitalize">{themeMode}</span>
          </span>
        }
      />

      {/* Stat row — every figure is real. `—`/`…` while loading, never a fake
          number. Trends only shown when real data backs them. */}
      <section aria-label="Workspace statistics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Projects"
          value={error ? '—' : initialLoading ? '…' : String(projects.length)}
          icon={FolderKanban}
          hint={error ? 'unavailable' : 'in your workspace'}
        />
        <StatCard
          label="Words Written"
          value={wordsWritten === undefined ? '…' : wordsWritten.toLocaleString()}
          icon={PenLine}
          hint="across all projects"
          trend={
            hasActivityHistory && (weekWords ?? 0) > 0
              ? { direction: 'up', label: `+${(weekWords ?? 0).toLocaleString()} this week` }
              : undefined
          }
        />
        <StatCard
          label="Writing Streak"
          value={writingStreak === undefined ? '…' : `${writingStreak} ${writingStreak === 1 ? 'day' : 'days'}`}
          icon={Flame}
          hint={
            hasActivityHistory
              ? `best: ${bestStreak ?? 0} ${(bestStreak ?? 0) === 1 ? 'day' : 'days'}`
              : 'no writing recorded yet'
          }
        />
        <StatCard
          label="Completed Chapters"
          value={completedChapters === undefined ? '…' : String(completedChapters)}
          icon={BookOpen}
          hint={totalChapters !== undefined ? `${completedChapters ?? 0} of ${totalChapters} chapters` : undefined}
        />
      </section>

      {/* Main workbench: 2/3 content + 1/3 rail on wide screens */}
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ContinueWritingCard target={stats?.continueTarget ?? null} wordsWritten={wordsWritten ?? 0} />
          <RecentProjectsCard
            projects={projects}
            loading={initialLoading}
            error={error}
            onRetry={() => void refresh()}
          />
          <QuickAccessCard />
        </div>

        <aside className="space-y-4" aria-label="Workspace details">
          {/* Real project data: loading / error+retry / status breakdown.
              Never renders "0" on failure — the error panel is shown instead. */}
          {error ? (
            <ProjectsError error={error} onRetry={() => void refresh()} />
          ) : initialLoading ? (
            <ProjectsLoading label="Loading project overview…" />
          ) : (
            <ProjectStatusCard projects={projects} />
          )}
          <WritingGoalCard
            goal={goal}
            todayWords={stats?.todayWords ?? 0}
            weekWords={weekWords ?? 0}
            weekSeries={stats?.weekSeries ?? []}
            bestStreak={bestStreak ?? 0}
            streak={writingStreak ?? 0}
            hasActivityHistory={hasActivityHistory}
            onSetGoal={async (target) => {
              await setGoal(target);
              await refreshStats();
            }}
            saving={goalSaving}
          />
          <RecentActivityCard entries={stats?.recentActivity ?? []} />
          <AiStatusCard />
        </aside>
      </div>

      {/* Create dialog. Reuses the shared form; the dialog manages its own
          saving/error state and only closes on success. The hook refreshes the
          dashboard's project data after a successful create. */}
      <ProjectFormDialog
        open={createOpen}
        onSubmit={handleCreate}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

