import { BookOpen, Flame, FolderKanban, LayoutDashboard, PenLine } from 'lucide-react';
import { Button, PageHeader } from '@/components/ui';
import { useThemeMode } from '@/core/theme/theme';
import { DEMO_STATS } from '@/modules/dashboard/demo-data';
import { StatCard } from '@/modules/dashboard/components/StatCard';
import { DemoDataBanner } from '@/modules/dashboard/components/DemoDataBanner';
import { ContinueWritingCard } from '@/modules/dashboard/components/ContinueWritingCard';
import { RecentProjectsCard } from '@/modules/dashboard/components/RecentProjectsCard';
import { QuickAccessCard } from '@/modules/dashboard/components/QuickAccessCard';
import { WritingGoalCard } from '@/modules/dashboard/components/WritingGoalCard';
import { RecentActivityCard } from '@/modules/dashboard/components/RecentActivityCard';
import { AiStatusCard } from '@/modules/dashboard/components/AiStatusCard';

/**
 * Dashboard — the workspace home.
 *
 * Layout: welcome header + demo banner, a 4-up stat row, then a two-column
 * workbench (main column 2/3, right rail 1/3) that collapses to a single
 * column below `xl`. All figures come from `demo-data.ts` and are explicitly
 * labelled as demo data.
 */
export function DashboardPage() {
  const themeMode = useThemeMode();

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
              disabled
              title="Project creation ships in P1"
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

      {/* Stat row */}
      <section aria-label="Workspace statistics" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total Projects"
          value={String(DEMO_STATS.totalProjects)}
          icon={FolderKanban}
          trend={{ direction: 'up', label: '+1 this month' }}
          hint="2 in progress"
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
          <RecentProjectsCard />
          <QuickAccessCard />
        </div>

        <aside className="space-y-4" aria-label="Workspace details">
          <WritingGoalCard />
          <RecentActivityCard />
          <AiStatusCard />
        </aside>
      </div>
    </div>
  );
}
