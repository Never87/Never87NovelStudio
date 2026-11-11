import { useState } from 'react';
import { BookOpen, Flame, FolderKanban, LayoutDashboard, PenLine } from 'lucide-react';
import { Button, PageHeader } from '@/components/ui';
import { useThemeMode } from '@/core/theme/theme';
import { useProjects } from '@/hooks';
import type { CreateProjectInput, UpdateProjectInput } from '@/services';
import { DEMO_STATS } from '@/modules/dashboard/demo-data';
import { ProjectsError, ProjectsLoading } from '@/modules/projects/components/ProjectsStates';
import { ProjectFormDialog } from '@/modules/projects/components/ProjectFormDialog';
import { StatCard } from '@/modules/dashboard/components/StatCard';
import { DemoDataBanner } from '@/modules/dashboard/components/DemoDataBanner';
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
 * Layout: welcome header + demo banner, a 4-up stat row, then a two-column
 * workbench (main column 2/3, right rail 1/3) that collapses to a single
 * column below `xl`.
 *
 * Data: the project overview blocks (total, recent and status breakdown) are
 * driven by real IndexedDB projects via a SINGLE `useProjects()` call. All
 * writing statistics, goals, activity and AI status remain clearly-labelled
 * demo data from `demo-data.ts`.
 *
 * Creating a project reuses the shared `ProjectFormDialog`. The hook's
 * `createProject` already refreshes the list on success, so the three real
 * blocks update on their own — no manual `refresh()` here. A failed create is
 * rethrown to the dialog, which shows the message and stays open.
 */
export function DashboardPage() {
  const themeMode = useThemeMode();
  // The single source of real project data for this page. Total Projects,
  // Recent Projects and the status breakdown all read from this one call.
  const { projects, initialLoading, error, refresh, createProject } = useProjects();

  // Create-dialog visibility. Closed by default.
  const [createOpen, setCreateOpen] = useState(false);

  /**
   * Delegates to the hook, which creates the project and refreshes the list.
   * Deliberately NOT wrapped in try/catch: the error must reach
   * `ProjectFormDialog` so it can surface it and keep the form open.
   * The dialog's `onSubmit` accepts Create | Update input; this entry point
   * only ever creates, so the payload is narrowed (same pattern as
   * `ProjectsPage.handleCreate`).
   */
  const handleCreate = async (input: CreateProjectInput | UpdateProjectInput) => {
    await createProject(input as CreateProjectInput);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LayoutDashboard className="size-4" />}
        eyebrow="Workspace"
        title="Welcome back, Never87"
        description="Your AI-assisted novel workbench: planning, world building, drafting and analysis in one place."
        actions={
          <>
            <Button variant="secondary" size="sm" disabled title="Project management ships in P1">
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
            Theme: <span className="text-muted font-medium capitalize">{themeMode}</span> · P0 preview build
          </span>
        }
      />

      <DemoDataBanner />

      {/* Stat row. Total Projects is real; the other three remain demo data. */}
      <section aria-label="Workspace statistics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Projects"
          value={error ? '—' : initialLoading ? '…' : String(projects.length)}
          icon={FolderKanban}
          hint={error ? 'unavailable' : 'in your workspace'}
        />
        <StatCard
          label="Words Written"
          value={DEMO_STATS.wordsWritten.toLocaleString()}
          icon={PenLine}
          trend={{ direction: 'up', label: '+6,420 this week' }}
          hint="across all projects"
        />
        <StatCard
          label="Writing Streak"
          value={`${DEMO_STATS.writingStreakDays} days`}
          icon={Flame}
          trend={{ direction: 'flat', label: 'No change' }}
          hint="best: 21 days"
        />
        <StatCard
          label="Completed Chapters"
          value={String(DEMO_STATS.completedChapters)}
          icon={BookOpen}
          trend={{ direction: 'up', label: '+3 this week' }}
          hint="7 drafts open"
        />
      </section>

      {/* Main workbench: 2/3 content + 1/3 rail on wide screens */}
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <ContinueWritingCard />
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
          <WritingGoalCard />
          <RecentActivityCard />
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

