import { useMemo } from 'react';
import { ArrowRight, History } from 'lucide-react';
import { ButtonLink, PageHeader } from '@/components/ui';
import { useProjects } from '@/hooks';
import { ProjectRow } from './components/ProjectRow';
import { ProjectsError, ProjectsLoading } from './components/ProjectsStates';

/** How many recently edited projects this page shows at most. */
const RECENT_LIMIT = 10;

/**
 * Recent Projects — the projects edited most recently (by `updatedAt`).
 *
 * Not "recently created": the list is explicitly sorted by `updatedAt`
 * descending, even though `useProjects()` already returns that order, so the
 * contract is guaranteed regardless of the hook's future ordering.
 */
export function RecentProjectsPage() {
  const { projects, initialLoading, loading, error, refresh } = useProjects();

  const recent = useMemo(
    () =>
      [...projects]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT_LIMIT),
    [projects],
  );

  const hasProjects = projects.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<History className="size-4" />}
        eyebrow="Library"
        title="Recent Projects"
        description="Jump straight back into the projects you edited most recently."
        actions={
          <ButtonLink
            variant="secondary"
            size="sm"
            to="/projects"
            iconRight={<ArrowRight className="size-3.5" />}
          >
            All projects
          </ButtonLink>
        }
      />

      {error ? (
        <ProjectsError error={error} onRetry={() => void refresh()} />
      ) : initialLoading ? (
        <ProjectsLoading label="Loading recent projects…" />
      ) : !hasProjects ? (
        <EmptyRecent />
      ) : (
        <>
          <p className="text-subtle text-2xs">
            Showing {recent.length} of {projects.length} most recently edited
            {loading ? ' · refreshing…' : ''}
          </p>
          <ul className="divide-line bg-surface divide-y overflow-hidden rounded-lg border border-line">
            {recent.map((project) => (
              <li key={project.id}>
                <ProjectRow project={project} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function EmptyRecent() {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
        <History className="size-5" aria-hidden />
      </span>
      <h3 className="text-ink text-sm font-semibold">Nothing edited recently</h3>
      <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
        Once you start writing, the projects you touched most recently will appear here.
      </p>
      <ButtonLink
        variant="primary"
        size="sm"
        className="mt-4"
        to="/projects"
        iconRight={<ArrowRight className="size-3.5" />}
      >
        Go to My Projects
      </ButtonLink>
    </div>
  );
}
