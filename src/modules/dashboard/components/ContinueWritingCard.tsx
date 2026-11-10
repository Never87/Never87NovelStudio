import { BookOpen, CalendarDays, PenLine, TrendingUp } from 'lucide-react';
import { Badge, Button, Card, CardHeader } from '@/components/ui';
import { DEMO_PROJECTS } from '@/modules/dashboard/demo-data';

const STATUS_META = {
  drafting: { label: 'Drafting', tone: 'accent' as const },
  revising: { label: 'Revising', tone: 'warning' as const },
  outlining: { label: 'Outlining', tone: 'info' as const },
};

/**
 * Continue Writing — the primary action surface.
 * Shows the most recently edited demo project with a direct resume affordance.
 */
export function ContinueWritingCard() {
  const project = DEMO_PROJECTS[0];
  const status = STATUS_META[project.status];

  return (
    <Card padding="lg" className="relative overflow-hidden">
      <div aria-hidden className="n87-grid-bg pointer-events-none absolute inset-x-0 top-0 h-24 opacity-60" />

      <div className="relative">
        <CardHeader
          title="Continue Writing"
          description="Pick up where you left off"
          icon={<PenLine className="size-4" />}
          action={<Badge tone={status.tone}>{status.label}</Badge>}
        />

        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-subtle text-2xs font-medium uppercase tracking-wider">{project.series}</p>
            <h3 className="text-ink truncate text-lg font-semibold">{project.title}</h3>
            <p className="text-muted mt-0.5 text-xs">
              Chapter 12 · “The Drowned Bell” — last edited {project.updatedAt}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled title="Story Editor ships in P4">
              Open Outline
            </Button>
            <Button variant="primary" size="sm" disabled title="Story Editor ships in P4" iconLeft={<PenLine className="size-3.5" />}>
              Resume Writing
            </Button>
          </div>
        </div>

        <div className="mt-4">
          <div className="text-subtle mb-1 flex items-center justify-between text-2xs">
            <span>Draft progress</span>
            <span className="text-muted font-medium">{project.progress}%</span>
          </div>
          <div className="bg-surface-muted h-1.5 w-full overflow-hidden rounded-full">
            <div className="bg-accent h-full rounded-full" style={{ width: `${project.progress}%` }} />
          </div>
        </div>

        <div className="text-muted mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <BookOpen className="text-subtle size-3.5" aria-hidden />
            {project.chapters} chapters
          </span>
          <span className="inline-flex items-center gap-1.5">
            <TrendingUp className="text-subtle size-3.5" aria-hidden />
            {project.words.toLocaleString()} words
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="text-subtle size-3.5" aria-hidden />
            Updated {project.updatedAt}
          </span>
        </div>
      </div>
    </Card>
  );
}
