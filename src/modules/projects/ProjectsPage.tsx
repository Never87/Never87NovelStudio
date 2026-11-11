import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowDownWideNarrow, FolderKanban, Plus, Search, SearchX, X } from 'lucide-react';
import { Button, PageHeader } from '@/components/ui';
import { useProjects } from '@/hooks';
import { PROJECT_STATUSES, type NovelProject, type ProjectStatus } from '@/types';
import type { CreateProjectInput, UpdateProjectInput } from '@/services';
import { ProjectRow } from './components/ProjectRow';
import { ProjectFormDialog } from './components/ProjectFormDialog';
import { DeleteProjectDialog } from './components/DeleteProjectDialog';
import { ProjectsError, ProjectsLoading } from './components/ProjectsStates';
import { PROJECT_STATUS_META } from './project-meta';
/** Sort options offered to the user. Display-only - never touches the DB. */
type SortKey = 'updated' | 'created' | 'title';

const SORT_LABELS: Record<SortKey, string> = {
  updated: 'Recently Updated',
  created: 'Recently Created',
  title: 'Title',
};

type StatusFilter = ProjectStatus | 'all';

/**
 * My Projects - real project list with local search, status filter and sort.
 *
 * All data comes from `useProjects()`. Filtering and sorting happen purely in
 * memory over the hook's result, so switching filters never re-queries the
 * database and never mutates the source data. The hook keeps the
 * `updatedAt`-descending order from the Service as the default sort.
 */
export function ProjectsPage() {
  const { projects, initialLoading, loading, error, refresh, createProject, updateProject, deleteProject } =
    useProjects();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('updated');
  const [createOpen, setCreateOpen] = useState(false);

  const location = useLocation();
  const navigate = useNavigate();

  /**
   * Honours an "open the create dialog" request handed over by the Topbar.
   *
   * The Topbar navigates to `/projects` with `state: { create: true }` instead
   * of rendering its own dialog, so there is exactly one create flow and one
   * `useProjects()` instance behind it.
   *
   * Keyed on `location.key` rather than on the state object so a REPEATED click
   * while already on `/projects` still opens the dialog: every `navigate()`
   * produces a new key even for the same path.
   *
   * On consumption the intent is cleared with `replace: true`, so neither a
   * refresh nor Back/Forward can re-open the dialog, and because the cleanup
   * writes `state: null` the effect does not re-fire in a loop.
   */
  const handledLocationKey = useRef<string | null>(null);
  useEffect(() => {
    const wantsCreate = (location.state as { create?: boolean } | null)?.create === true;
    if (!wantsCreate || handledLocationKey.current === location.key) return;

    handledLocationKey.current = location.key;
    setCreateOpen(true);

    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.key, location.state, location.pathname, location.search, navigate]);

  // The project being edited, or null when the edit dialog is closed.
  const [editingProject, setEditingProject] = useState<NovelProject | null>(null);
  // The project pending deletion, or null when the confirm dialog is closed.
  const [deletingProject, setDeletingProject] = useState<NovelProject | null>(null);

  const normalizedQuery = query.trim().toLowerCase();

  const visibleProjects = useMemo(() => {
    const filtered = projects.filter((project) => {
      if (statusFilter !== 'all' && project.status !== statusFilter) return false;
      if (!normalizedQuery) return true;

      const haystack = [
        project.title,
        project.description,
        ...project.genre,
        ...project.tags,
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedQuery);
    });

    // Copy before sorting so the hook's array is never mutated in place.
    const sorted = [...filtered];
    switch (sortKey) {
      case 'created':
        sorted.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        break;
      case 'updated':
      default:
        sorted.sort((a, b) => b.updatedAt - a.updatedAt);
        break;
    }
    return sorted;
  }, [projects, statusFilter, normalizedQuery, sortKey]);

  const hasProjects = projects.length > 0;
  const isFiltering = normalizedQuery.length > 0 || statusFilter !== 'all';
  const noMatches = hasProjects && visibleProjects.length === 0 && isFiltering;

  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
  };

  /**
   * Create submit handler. The dialog owns its saving/error state and only
   * closes on success, so a failure keeps the form open with the user's input.
   * The hook refreshes the list after a successful create, so no manual
   * refresh is needed here.
   */
  const handleCreate = async (input: CreateProjectInput | UpdateProjectInput) => {
    await createProject(input as CreateProjectInput);
  };

  /**
   * Edit submit handler. The edit dialog always sends an UpdateProjectInput
   * (only changed fields). The hook refreshes the list on success; on failure
   * the error propagates back to the dialog, which stays open with the input.
   */
  const handleEditSubmit = async (input: CreateProjectInput | UpdateProjectInput) => {
    if (!editingProject) return;
    await updateProject(editingProject.id, input as UpdateProjectInput);
  };

  /**
   * Delete confirm handler. Only reached after the user presses Delete in the
   * dialog; Cancel/Escape simply close it via onClose without deleting. The
   * hook refreshes the list on success; on failure the error propagates back
   * to the dialog, which stays open with the message.
   */
  const handleDelete = async () => {
    if (!deletingProject) return;
    await deleteProject(deletingProject.id);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FolderKanban className="size-4" />}
        eyebrow="Library"
        title="My Projects"
        description="Create, organise and manage every novel project in your workspace."
        actions={
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Plus className="size-3.5" />}
            onClick={() => setCreateOpen(true)}
          >
            New Project
          </Button>
        }
      />

      {/* Toolbar: search + status filter + sort */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            className="text-subtle pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, description, genre, tags..."
            aria-label="Search projects"
            className="bg-surface text-ink placeholder:text-subtle border-line h-9 w-full rounded-md border pr-8 pl-8 text-sm"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="text-subtle hover:text-ink absolute right-2 top-1/2 -translate-y-1/2"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        <label className="text-subtle flex items-center gap-1.5 text-xs">
          <span className="sr-only">Filter by status</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            aria-label="Filter by status"
            className="bg-surface text-ink border-line h-9 rounded-md border px-2 text-sm"
          >
            <option value="all">All statuses</option>
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {PROJECT_STATUS_META[status].label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-subtle flex items-center gap-1.5 text-xs">
          <ArrowDownWideNarrow className="size-3.5" aria-hidden />
          <span className="sr-only">Sort projects</span>
          <select
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value as SortKey)}
            aria-label="Sort projects"
            className="bg-surface text-ink border-line h-9 rounded-md border px-2 text-sm"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Result count */}
      {hasProjects && !initialLoading && !error ? (
        <p className="text-subtle text-2xs">
          Showing {visibleProjects.length} of {projects.length}
          {isFiltering ? ' matching' : ''} project{projects.length === 1 ? '' : 's'}
          {loading ? ' · refreshing...' : ''}
        </p>
      ) : null}

      {/* Body: five distinct states */}
      {error ? (
        <ProjectsError error={error} onRetry={() => void refresh()} />
      ) : initialLoading ? (
        <ProjectsLoading />
      ) : !hasProjects ? (
        <EmptyProjects onCreate={() => setCreateOpen(true)} />
      ) : noMatches ? (
        <NoMatches onClear={clearFilters} />
      ) : (
        <ul className="divide-line bg-surface divide-y overflow-hidden rounded-lg border border-line">
          {visibleProjects.map((project) => (
            <li key={project.id}>
              <ProjectRow
                project={project}
                onEdit={setEditingProject}
                onDelete={setDeletingProject}
              />
            </li>
          ))}
        </ul>
      )}

      {/* Create dialog. Reuses the shared form; the dialog manages its own
          saving/error state and only closes on success. */}
      <ProjectFormDialog
        open={createOpen}
        onSubmit={handleCreate}
        onClose={() => setCreateOpen(false)}
      />

      {/* Edit dialog. Keyed by project id so switching targets remounts the
          form and re-seeds it from the selected project. */}
      <ProjectFormDialog
        key={editingProject?.id ?? 'edit'}
        open={editingProject !== null}
        initialProject={editingProject}
        onSubmit={handleEditSubmit}
        onClose={() => setEditingProject(null)}
      />

      {/* Delete confirm dialog. Cancel/Escape close it without deleting; only
          the Delete button runs handleDelete, and the dialog stays open on
          failure so the error is visible and retryable. */}
      <DeleteProjectDialog
        open={deletingProject !== null}
        projectTitle={deletingProject?.title ?? ''}
        onConfirm={handleDelete}
        onClose={() => setDeletingProject(null)}
      />
    </div>
  );
}

function EmptyProjects({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
        <FolderKanban className="size-5" aria-hidden />
      </span>
      <h3 className="text-ink text-sm font-semibold">No projects yet</h3>
      <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
        Projects are the root of every novel: outline, characters, world and drafts all live inside
        one.
      </p>
      <Button
        variant="primary"
        size="sm"
        className="mt-4"
        iconLeft={<Plus className="size-3.5" />}
        onClick={onCreate}
      >
        Create your first project
      </Button>
    </div>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
        <SearchX className="size-5" aria-hidden />
      </span>
      <h3 className="text-ink text-sm font-semibold">No matching projects</h3>
      <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
        No projects match your current search and filters.
      </p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}
