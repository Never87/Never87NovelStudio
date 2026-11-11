import { PieChart } from 'lucide-react';

import { Badge, Card, CardHeader } from '@/components/ui';
import { PROJECT_STATUSES, type NovelProject, type ProjectStatus } from '@/types';
import { PROJECT_STATUS_META } from '@/modules/projects/project-meta';
import { cn } from '@/utils/cn';

export interface ProjectStatusCardProps {
  /** Real projects to aggregate. Never demo data. */
  projects: NovelProject[];
}

/**
 * Projects per lifecycle status.
 *
 * Counts are derived in memory from the already-loaded project list — no extra
 * request, no new chart dependency. Every legal `ProjectStatus` is rendered,
 * including zeroes, so the block never shrinks based on data.
 *
 * Status labels and badge tones come from `PROJECT_STATUS_META`; this component
 * holds no second copy of that mapping.
 */
export function ProjectStatusCard({ projects }: ProjectStatusCardProps) {
  const counts = countByStatus(projects);
  const total = projects.length;

  return (
    <Card padding="md">
      <CardHeader
        title="Projects by Status"
        description="Across all projects"
        icon={<PieChart className="size-4" />}
      />
      <ul className="mt-3 space-y-2">
        {PROJECT_STATUSES.map((status) => {
          const count = counts[status];
          const share = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <li key={status} className="flex items-center gap-2">
              <Badge tone={PROJECT_STATUS_META[status].tone} size="sm" dot>
                {PROJECT_STATUS_META[status].label}
              </Badge>
              <span className="bg-surface-muted h-1.5 min-w-0 flex-1 overflow-hidden rounded-full">
                <span
                  className={cn('bg-accent block h-full rounded-full transition-[width]')}
                  style={{ width: `${share}%` }}
                />
              </span>
              <span className="text-muted w-8 shrink-0 text-right text-2xs tabular-nums">{count}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-subtle mt-3 border-t border-line pt-2 text-2xs">
        {total} {total === 1 ? 'project' : 'projects'} in total
      </p>
    </Card>
  );
}

/** Counts projects per status, seeding every legal status with 0. */
function countByStatus(projects: NovelProject[]): Record<ProjectStatus, number> {
  const counts = Object.fromEntries(PROJECT_STATUSES.map((status) => [status, 0])) as Record<
    ProjectStatus,
    number
  >;
  for (const project of projects) {
    counts[project.status] += 1;
  }
  return counts;
}
