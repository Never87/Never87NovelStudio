import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FolderKanban } from 'lucide-react';
import { ButtonLink, Card, EmptyState, PageHeader } from '@/components/ui';
import { useProjects } from '@/hooks';
import { useStoryEditorStore } from '@/stores/story-editor-store';

export interface ProjectScopedPageProps {
  /** Page title (e.g. "World Building"). */
  title: string;
  /** One-line description shown under the title. */
  description?: string;
  /** Optional icon rendered in the header. */
  icon?: ReactNode;
  /** Small kicker above the title (usually "Novel Creation"). */
  eyebrow?: string;
  /** Renders the module content for the selected project. */
  children: (projectId: string) => ReactNode;
  /** Extra actions rendered in the header (beside the project selector). */
  actions?: ReactNode;
}

/**
 * Standalone, project-scoped module shell (Round 1 — Novel Creation).
 *
 * The Novel Creation modules (World, Characters, Narrative, Outline, Scenes,
 * Story Editor) previously existed only as tabs inside a project's detail page.
 * This shell gives each one a FIRST-CLASS sidebar route of its own while
 * REUSING the exact same panels and data hooks as the project tabs — so there
 * is one data model and one implementation, never a duplicate.
 *
 * The selected project is persisted in the `?project=<id>` query string, so:
 *   - refreshing keeps the same project open,
 *   - the URL is shareable / bookmarkable,
 *   - switching modules keeps the selection (the same param is used everywhere).
 *
 * If no project is selected (or the workspace is empty) it shows a clear
 * selector / empty state instead of a blank page.
 */
export function ProjectScopedPage({
  title,
  description,
  icon,
  eyebrow = 'Novel Creation',
  children,
  actions,
}: ProjectScopedPageProps) {
  const { projects, initialLoading } = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('project');
  // Story Editor Focus Mode strips the page chrome so the writing surface fills
  // the shell. `focusMode` is only ever true from the Story Editor (it auto-
  // clears elsewhere), so other project-scoped modules are unaffected.
  const focusMode = useStoryEditorStore((state) => state.focusMode);

  // Resolve the requested project, falling back to the first project so a
  // freshly-opened module shows real content instead of asking every time.
  const selectedId = useMemo(() => {
    if (requested && projects.some((project) => project.id === requested)) return requested;
    return projects[0]?.id ?? null;
  }, [requested, projects]);

  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;

  const selectProject = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('project', id);
    setSearchParams(next, { replace: true });
  };

  const toolbar =
    projects.length > 0 ? (
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="scoped-project" className="text-subtle text-2xs font-medium uppercase tracking-wide">
          Project
        </label>
        <select
          id="scoped-project"
          value={selectedId ?? ''}
          onChange={(event) => selectProject(event.target.value)}
          className="border-line bg-surface text-ink focus:border-accent max-w-xs rounded-md border px-2 py-1.5 text-sm"
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
        {selectedProject ? (
          <ButtonLink variant="ghost" size="sm" to={`/projects/${selectedProject.id}`}>
            Open project
          </ButtonLink>
        ) : null}
      </div>
    ) : null;

  // Focus Mode: hide the page chrome (header/selector/padding) so the module
  // content fills the shell — but keep `children` at the SAME tree position so
  // the Story Editor's editor instance is never remounted (its unmount cleanup
  // resets focus mode, which would otherwise immediately undo the toggle).
  const compact = focusMode && !!selectedId;

  return (
    <div className={compact ? 'h-full min-h-0' : 'space-y-5'}>
      {/* Always rendered but hidden in Focus Mode so the children below keep
          their tree position → the editor is never remounted when toggling. */}
      <div className={compact ? 'hidden' : undefined}>
        <PageHeader icon={icon} eyebrow={eyebrow} title={title} description={description} actions={actions} toolbar={toolbar} />
      </div>

      {initialLoading ? (
        <Card padding="lg">
          <p className="text-subtle text-xs" role="status">
            Loading projects…
          </p>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="size-5" aria-hidden />}
          title="No project yet"
          description={`Create a project first — ${title} works on one project at a time.`}
          action={
            <ButtonLink variant="primary" size="sm" to="/projects">
              Go to My Projects
            </ButtonLink>
          }
        />
      ) : selectedId ? (
        <div className={compact ? 'h-full min-h-0' : undefined}>{children(selectedId)}</div>
      ) : null}
    </div>
  );
}
