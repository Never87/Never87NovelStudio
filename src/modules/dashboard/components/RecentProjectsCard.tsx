import { ArrowRight, FolderKanban } from 'lucide-react';
import { Badge, Card, CardHeader } from '@/components/ui';
import { DEMO_PROJECTS } from '@/modules/dashboard/demo-data';

const STATUS_META = {
  drafting: { label: 'Drafting', tone: 'accent' as const },
  revising: { label: 'Revising', tone: 'warning' as const },
  outlining: { label: 'Outlining', tone: 'info' as const },
};

/** Recently edited projects (demo). Rows are non-interactive until P1. */
export function RecentProjectsCard() {
  return (
    <Card padding="none">
      <div className="px-4 pt-4">
        <CardHeader
          title="Recent Projects"
          description="Sorted by last edit time"
          icon={<FolderKanban className="size-4" />}
        />
      </div>

      <ul className="mt-2 divide-y divide-line">
        {DEMO_PROJECTS.map((project) => {
          const status = STATUS_META[project.status];
          return (
            <li key={project.id} className="hover:bg-surface-muted/60 flex items-center gap-3 px-4 py-2.5">
              <span
                aria-hidden
                className="bg-accent-soft text-accent-soft-text grid size-8 shrink-0 place-items-center rounded-md text-2xs font-semibold"
              >
                {project.title.slice(0, 2).toUpperCase()}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-ink truncate text-sm font-medium">{project.title}</p>
                  <Badge tone={status.tone} size="sm">
                    {status.label}
                  </Badge>
                </div>
                <p className="text-subtle truncate text-2xs">
                  {project.series} · {project.chapters} chapters · {project.words.toLocaleString()} words
                </p>
              </div>

              <div className="hidden w-28 shrink-0 sm:block">
                <div className="bg-surface-muted h-1 w-full overflow-hidden rounded-full">
                  <div className="bg-accent h-full rounded-full" style={{ width: `${project.progress}%` }} />
                </div>
              </div>

              <span className="text-subtle w-20 shrink-0 text-right text-2xs">{project.updatedAt}</span>

              <ArrowRight className="text-subtle hidden size-3.5 shrink-0 md:block" aria-hidden />
            </li>
          );
        })}
      </ul>

      <p className="text-subtle border-t border-line px-4 py-2 text-2xs">
        Project management and real data arrive in P1.
      </p>
    </Card>
  );
}
