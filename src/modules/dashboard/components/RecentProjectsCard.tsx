import { ArrowRight, FolderKanban, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, ButtonLink, Card, CardHeader, EmptyState } from '@/components/ui';
import type { NovelProject } from '@/types';
import { PROJECT_STATUS_META, formatDate, projectInitials } from '@/modules/projects/project-meta';
import { formatRelative } from '@/utils/date';

export interface RecentProjectsCardProps {
  /** Real projects. Already loaded once by the dashboard page. */
  projects: NovelProject[];
  /** Show a skeleton-free note while the first load is in flight. */
  loading?: boolean;
  /** Set when loading failed. Takes precedence over the empty state. */
  error?: unknown;
  /** Retries the load. Wired to the hook's `refresh()`. */
  onRetry?: () => void;
}

const RECENT_LIMIT = 5;

/**
 * The most recently updated projects.
 *
 * Sorts a copy by `updatedAt` (descending) locally so the card never depends on
 * whatever order the hook happens to return — the repository's ordering is not
 * re-implemented or changed. Rows link to the real detail page.
 */
export function RecentProjectsCard({
  projects,
  loading = false,
  error,
  onRetry,
}: RecentProjectsCardProps) {
  const recent = [...projects]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT_LIMIT);
  const failed = Boolean(error);

  return (
    <Card padding="none">
      <div className="px-4 pt-4">
        <CardHeader
          title="Recent Projects"
          description="Sorted by last edit time"
          icon={<FolderKanban className="size-4" />}
        />
      </div>

      {failed ? (
        <div className="text-warning flex flex-col items-center gap-2 px-4 py-8 text-center" role="alert">
          <TriangleAlert className="size-5" aria-hidden />
          <p className="text-muted text-xs">Couldn’t load recent projects.</p>
          {onRetry ? (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Retry
                </Button>
          ) : null}
        </div>
      ) : loading && projects.length === 0 ? (
        <p className="text-subtle px-4 py-8 text-center text-xs">Loading projects…</p>
      ) : recent.length === 0 ? (
        <div className="p-4">
          <EmptyState
            variant="plain"
            icon={<FolderKanban className="size-5" />}
            title="No projects yet"
            description="Create your first project to see it appear here."
            action={
              <ButtonLink to="/projects" size="sm" variant="primary">
                Go to Projects
              </ButtonLink>
            }
          />
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {recent.map((project) => {
            const meta = PROJECT_STATUS_META[project.status];
            return (
              <li key={project.id}>
                <Link
                  to={`/projects/${project.id}`}
                  className="hover:bg-surface-muted/60 focus-visible:bg-surface-muted/60 flex items-center gap-3 px-4 py-2.5"
                >
                  <span
                    aria-hidden
                    className="bg-accent-soft text-accent-soft-text grid size-8 shrink-0 place-items-center rounded-md text-2xs font-semibold"
                  >
                    {projectInitials(project.title)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-ink truncate text-sm font-medium">{project.title}</p>
                      <Badge tone={meta.tone} size="sm">
                        {meta.label}
                      </Badge>
                    </div>
                    <p className="text-subtle truncate text-2xs">
                      {project.targetWordCount !== undefined
                        ? `Target ${project.targetWordCount.toLocaleString()} words`
                        : 'No word target'}
                    </p>
                  </div>

                  <span
                    className="text-subtle w-20 shrink-0 text-right text-2xs"
                    title={formatDate(project.updatedAt)}
                  >
                    {formatRelative(project.updatedAt)}
                  </span>

                  <ArrowRight className="text-subtle hidden size-3.5 shrink-0 md:block" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {failed ? null : (
        <p className="text-subtle border-t border-line px-4 py-2 text-2xs">
          Showing the {Math.min(recent.length, RECENT_LIMIT)} most recently updated.
        </p>
      )}
    </Card>
  );
}
