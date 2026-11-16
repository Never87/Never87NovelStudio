import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { BarChart3, BookOpenText, CheckCircle2, Flame, Target, TrendingUp } from 'lucide-react';
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { useProjects, useWorkspaceStats } from '@/hooks';
import { cn } from '@/utils/cn';

/**
 * Writing Statistics (Round 1 - Workspace, was PLACEHOLDER).
 *
 * A real analytics surface computed from the SAME data as the Dashboard
 * (chapter/scene manuscript word counts + the writing-activity ledger). It
 * shows workspace totals, a 30-day output chart, a per-project breakdown table
 * with a mini 7-day sparkline, and goal progress against the shared daily goal.
 *
 * No value is fabricated: an empty workspace renders an honest empty state.
 */
export function StatisticsPage() {
  const { stats, loading, initialLoading, error, refresh } = useWorkspaceStats();
  const { projects } = useProjects();

  if (initialLoading) {
    return (
      <div className="space-y-5">
        <Header />
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Computing statistics...
          </p>
        </Card>
      </div>
    );
  }

  if (error && !stats) {
    return (
      <div className="space-y-5">
        <Header />
        <Card padding="lg">
          <p className="text-danger text-sm">Statistics could not be loaded.</p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-accent-soft-text mt-2 text-xs underline"
          >
            Retry
          </button>
        </Card>
      </div>
    );
  }

  if (!stats || stats.totals.projects === 0) {
    return (
      <div className="space-y-5">
        <Header />
        <EmptyState
          icon={<BarChart3 className="size-5" aria-hidden />}
          title="No statistics yet"
          description="Statistics are derived from your writing sessions. Create a project and start writing (or import a manuscript) to begin tracking."
          hints={[
            'Create a project under My Projects',
            'Write a chapter in the Story Editor',
            'Daily output is recorded as you type',
          ]}
        />
      </div>
    );
  }

  const goal = stats.goal;
  const dailyTarget = goal?.dailyWordTarget ?? 0;
  const dailyPercent =
    dailyTarget > 0 ? Math.min(100, Math.round((stats.totals.todayWords / dailyTarget) * 100)) : 0;

  return (
    <div className="space-y-5">
      <Header
        actions={
          <button
            type="button"
            onClick={() => void refresh()}
            className="text-subtle hover:text-ink text-2xs underline"
            disabled={loading}
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Projects" value={stats.totals.projects.toLocaleString()} icon={<BookOpenText className="size-3.5" />} />
        <Kpi label="Words written" value={stats.totals.wordsWritten.toLocaleString()} icon={<TrendingUp className="size-3.5" />} />
        <Kpi
          label="Chapters"
          value={`${stats.totals.completedChapters.toLocaleString()} / ${stats.totals.totalChapters.toLocaleString()}`}
          hint="completed / total"
          icon={<CheckCircle2 className="size-3.5" />}
        />
        <Kpi label="Today" value={`${stats.totals.todayWords.toLocaleString()} w`} icon={<Target className="size-3.5" />} />
        <Kpi label="This week" value={`${stats.totals.weekWords.toLocaleString()} w`} icon={<BarChart3 className="size-3.5" />} />
        <Kpi
          label="Streak"
          value={`${stats.totals.writingStreak} d`}
          hint={`best ${stats.totals.bestStreak}`}
          icon={<Flame className="size-3.5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card padding="md">
          <CardHeader title="Last 30 days" description="Words written per day across all projects" icon={<BarChart3 className="size-4" />} />
          <div className="mt-3 h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.monthSeries} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="dateKey"
                  tickLine={false}
                  axisLine={false}
                  interval={4}
                  tick={{ fontSize: 10, fill: 'var(--n87-text-subtle)' }}
                  tickFormatter={(v: string) => v.slice(5)}
                  dy={4}
                />
                <Tooltip
                  cursor={{ fill: 'var(--n87-surface-muted)' }}
                  contentStyle={{
                    fontSize: 11,
                    borderRadius: 8,
                    border: '1px solid var(--n87-border)',
                    background: 'var(--n87-surface)',
                    color: 'var(--n87-text)',
                  }}
                  formatter={(value) => [`${Number(value ?? 0).toLocaleString()} words`, 'Output']}
                />
                <Bar dataKey="words" fill="var(--n87-accent)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          {!stats.hasActivityHistory ? (
            <p className="text-subtle mt-2 text-2xs italic">
              No daily output recorded yet - this chart fills in as you write going forward.
            </p>
          ) : null}
        </Card>

        <Card padding="md">
          <CardHeader
            title="Daily goal"
            description={goal ? `${dailyTarget.toLocaleString()} words / day` : 'No goal set'}
            icon={<Target className="size-4" />}
          />
          {goal ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-muted text-xs">Today</span>
                <span className="text-2xs text-subtle">
                  <span className="text-ink font-semibold">{stats.totals.todayWords.toLocaleString()}</span>
                  {' / '}
                  {dailyTarget.toLocaleString()}
                </span>
              </div>
              <div className="bg-surface-muted h-2 w-full overflow-hidden rounded-full">
                <div className="bg-accent h-full rounded-full" style={{ width: `${dailyPercent}%` }} />
              </div>
              <p className="text-subtle text-2xs">{dailyPercent}% of today&apos;s target reached.</p>
              <Link to="/goals" className="text-accent-soft-text text-2xs underline">
                Edit goal on the Writing Goals page
              </Link>
            </div>
          ) : (
            <div className="mt-4 space-y-2">
              <p className="text-muted text-xs">No daily goal set.</p>
              <Link to="/goals" className="text-accent-soft-text text-xs underline">
                Set a daily word target
              </Link>
            </div>
          )}
        </Card>
      </div>

      <Card padding="none">
        <div className="border-line border-b px-4 py-3">
          <h2 className="text-ink text-sm font-semibold">Per-project breakdown</h2>
          <p className="text-subtle text-2xs">Sorted by total words written</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-subtle border-line border-b text-2xs uppercase tracking-wide">
                <th className="px-4 py-2 text-left font-medium">Project</th>
                <th className="px-4 py-2 text-right font-medium">Words</th>
                <th className="px-4 py-2 text-right font-medium">Chapters</th>
                <th className="px-4 py-2 text-right font-medium">Today</th>
                <th className="px-4 py-2 text-right font-medium">Week</th>
                <th className="px-4 py-2 text-right font-medium">7-day</th>
              </tr>
            </thead>
            <tbody>
              {stats.projects.map((p) => {
                const known = projects.find((proj) => proj.id === p.projectId);
                return (
                  <tr key={p.projectId} className="border-line border-b last:border-0">
                    <td className="px-4 py-2">
                      <Link
                        to={known ? `/projects/${p.projectId}` : '/projects'}
                        className="text-ink hover:text-accent-soft-text font-medium"
                      >
                        {p.projectTitle}
                      </Link>
                    </td>
                    <td className="text-muted px-4 py-2 text-right tabular-nums">{p.wordsWritten.toLocaleString()}</td>
                    <td className="text-muted px-4 py-2 text-right tabular-nums">
                      {p.completedChapters} / {p.totalChapters}
                    </td>
                    <td className="text-muted px-4 py-2 text-right tabular-nums">{p.todayWords.toLocaleString()}</td>
                    <td className="text-muted px-4 py-2 text-right tabular-nums">{p.weekWords.toLocaleString()}</td>
                    <td className="px-4 py-2">
                      <Sparkline series={p.weekSeries.map((d) => d.words)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Header({ actions }: { actions?: ReactNode }) {
  return (
    <PageHeader
      icon={<BarChart3 className="size-4" />}
      eyebrow="Workspace"
      title="Writing Statistics"
      description="Real word counts, daily output and progress across all your projects."
      actions={actions}
    />
  );
}

function Kpi({ label, value, hint, icon }: { label: string; value: string; hint?: string; icon?: ReactNode }) {
  return (
    <Card padding="sm">
      <div className="text-subtle flex items-center gap-1 text-2xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-ink mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-subtle text-2xs">{hint}</div> : null}
    </Card>
  );
}

/** Tiny inline bar chart for a project's last-7-days output. */
function Sparkline({ series }: { series: number[] }) {
  const max = Math.max(1, ...series);
  return (
    <div className="flex items-end justify-end gap-0.5" aria-hidden>
      {series.map((words, index) => (
        <span
          key={index}
          className={cn('bg-accent/70 w-1.5 rounded-sm', words === 0 && 'bg-line')}
          style={{ height: `${Math.max(2, Math.round((words / max) * 24))}px` }}
          title={`${words} words`}
        />
      ))}
    </div>
  );
}
