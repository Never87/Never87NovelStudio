import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Calendar, CalendarClock, Clapperboard, Compass, FileX2, ListTree, FolderKanban, Globe2, Languages, Pencil, Trash2, User, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button, ButtonLink, Card, PageHeader } from '@/components/ui';
import { useProject } from '@/hooks';
import type { UpdateProjectInput } from '@/services';
import { WorldPanel } from '@/modules/world/WorldPanel';
import { CharactersPanel } from '@/modules/characters/CharactersPanel';
import { NarrativePanel } from '@/modules/narrative/NarrativePanel';
import { OutlinePanel } from '@/modules/outline/OutlinePanel';
import { WritingPanel } from '@/modules/editor/WritingPanel';
import { ScenesProsePanel } from '@/modules/editor/ScenesProsePanel';
import { cn } from '@/utils/cn';
import { ProjectFormDialog } from './components/ProjectFormDialog';
import { DeleteProjectDialog } from './components/DeleteProjectDialog';
import { ProjectsError, ProjectsLoading } from './components/ProjectsStates';
import { formatDate, PROJECT_STATUS_META } from './project-meta';

/** Detail tabs: overview (P1), world & characters (P2-A), narrative (P2-B), outline (P3), writing (P4). */
type DetailTab = 'overview' | 'world' | 'characters' | 'narrative' | 'outline' | 'writing';

const DETAIL_TABS: Array<{ id: DetailTab; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <FolderKanban className="size-3.5" aria-hidden /> },
  { id: 'world', label: 'World', icon: <Globe2 className="size-3.5" aria-hidden /> },
  { id: 'characters', label: 'Characters', icon: <Users className="size-3.5" aria-hidden /> },
  { id: 'narrative', label: 'Narrative', icon: <Compass className="size-3.5" aria-hidden /> },
  { id: 'outline', label: 'Outline', icon: <ListTree className="size-3.5" aria-hidden /> },
  { id: 'writing', label: 'Writing', icon: <BookOpen className="size-3.5" aria-hidden /> },
];

/** Sub-views of the Writing tab: chapter manuscripts vs scene-level prose. */
type WritingView = 'chapters' | 'scenes';

const WRITING_VIEWS: Array<{ id: WritingView; label: string; icon: ReactNode }> = [
  { id: 'chapters', label: 'Chapter manuscripts', icon: <BookOpen className="size-3.5" aria-hidden /> },
  { id: 'scenes', label: 'Scene prose', icon: <Clapperboard className="size-3.5" aria-hidden /> },
];

/**
 * Project detail page (`/projects/:projectId`).
 *
 * Editable: shows a single project's persisted fields with Edit and Delete
 * actions. Editing reuses the shared ProjectFormDialog; deleting navigates back
 * to the list on success.
 *
 * Data flows exclusively through `useProject(projectId)`. The hook already
 * distinguishes `not-found` from `error`, guards against stale responses when
 * the id changes, and exposes `refresh()` for Retry.
 */
export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { project, status, notFound, error, refresh, updateProject, deleteProject } =
    useProject(projectId);
  const navigate = useNavigate();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('overview');
  // Sticky inside the Writing tab, so leaving to the Outline and coming back
  // returns the author to the prose view they were last working in.
  const [writingView, setWritingView] = useState<WritingView>('chapters');

  const backLink = (
    <ButtonLink
      variant="ghost"
      size="sm"
      to="/projects"
      iconLeft={<ArrowLeft className="size-3.5" />}
    >
      Back to My Projects
    </ButtonLink>
  );

  // idle (no id) / loading — never render stale content while a new id loads.
  if (status === 'idle' || status === 'loading') {
    return (
      <div className="space-y-5">
        <div>{backLink}</div>
        <ProjectsLoading label="Loading project…" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-5">
        <div>{backLink}</div>
        <ProjectNotFound projectId={projectId} />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="space-y-5">
        <div>{backLink}</div>
        <ProjectsError error={error} onRetry={() => void refresh()} />
      </div>
    );
  }

  // `status === 'success'`: the hook guarantees `project` is non-null here, but
  // guard defensively so a contract change can never crash the page.
  if (!project) {
    return (
      <div className="space-y-5">
        <div>{backLink}</div>
        <ProjectNotFound projectId={projectId} />
      </div>
    );
  }

  /**
   * Edit submit handler. The dialog sends an UpdateProjectInput (changed fields
   * only); the hook applies it, preserves id/createdAt, and refreshes the local
   * project with the saved result. On failure the error propagates back to the
   * dialog, which stays open with the input intact.
   */
  const handleEditSubmit = async (input: UpdateProjectInput) => {
    await updateProject(input);
  };

  /**
   * Delete confirm handler. Only reached after the user presses Delete; the
   * hook rejects on failure (dialog stays open) and resolves on success, after
   * which we navigate back to the list.
   */
  const handleDelete = async () => {
    await deleteProject();
    navigate('/projects');
  };

  const statusMeta = PROJECT_STATUS_META[project.status];
  const { author, language } = project.settings;

  return (
    <div className="space-y-5">
      <div>{backLink}</div>

      <PageHeader
        icon={<FolderKanban className="size-4" />}
        eyebrow="Project"
        title={project.title}
        description={project.description || undefined}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusMeta.tone} dot>
              {statusMeta.label}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              iconLeft={<Pencil className="size-3.5" />}
              onClick={() => setEditOpen(true)}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              size="sm"
              iconLeft={<Trash2 className="size-3.5" />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </div>
        }
        toolbar={
          // Scrolls horizontally on narrow screens instead of wrapping awkwardly.
          <div role="tablist" aria-label="Project sections" className="flex items-center gap-1 overflow-x-auto">
            {DETAIL_TABS.map((detailTab) => {
              const selected = tab === detailTab.id;
              return (
                <button
                  key={detailTab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(detailTab.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                    selected
                      ? 'bg-accent-soft text-accent-soft-text'
                      : 'text-muted hover:bg-surface-muted hover:text-ink',
                  )}
                >
                  {detailTab.icon}
                  {detailTab.label}
                </button>
              );
            })}
          </div>
        }
      />

      {tab === 'overview' ? (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          {/* Main info card */}
          <Card padding="md">
            <h2 className="text-ink text-sm font-semibold">Project details</h2>
            <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="Status">
                <Badge tone={statusMeta.tone} size="sm" dot>
                  {statusMeta.label}
                </Badge>
              </Field>
              <Field label="Genre">
                {project.genre.length > 0 ? (
                  <span className="text-muted">{project.genre.join(' · ')}</span>
                ) : (
                  <Muted>None</Muted>
                )}
              </Field>
              <Field label="Target word count">
                {project.targetWordCount !== undefined ? (
                  <span className="text-muted">{project.targetWordCount.toLocaleString()} words</span>
                ) : (
                  <Muted>Not set</Muted>
                )}
              </Field>
              <Field label="Created" icon={<Calendar className="size-3.5" aria-hidden />}>
                <span className="text-muted">{formatDate(project.createdAt)}</span>
              </Field>
              <Field label="Last updated" icon={<CalendarClock className="size-3.5" aria-hidden />}>
                <span className="text-muted">{formatDate(project.updatedAt)}</span>
              </Field>
            </dl>

            <div className="mt-4">
              <dt className="text-subtle text-2xs font-medium uppercase tracking-wide">Description</dt>
              <dd className="text-muted mt-1 text-sm whitespace-pre-line">
                {project.description || <Muted>No description</Muted>}
              </dd>
            </div>

            <div className="mt-4">
              <dt className="text-subtle text-2xs font-medium uppercase tracking-wide">Tags</dt>
              <dd className="mt-1.5">
                {project.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1">
                    {project.tags.map((tag) => (
                      <span
                        key={tag}
                        className="bg-surface-muted text-muted border-line inline-flex items-center rounded border px-1.5 py-0.5 text-2xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : (
                  <Muted>None</Muted>
                )}
              </dd>
            </div>
          </Card>

          {/* Settings summary (read-only) */}
          <Card padding="md">
            <h2 className="text-ink text-sm font-semibold">Settings</h2>
            <p className="text-subtle mt-1 text-2xs">Read-only summary.</p>
            <dl className="mt-3 space-y-2.5">
              <Field label="Author" icon={<User className="size-3.5" aria-hidden />}>
                {author ? <span className="text-muted">{author}</span> : <Muted>Not set</Muted>}
              </Field>
              <Field label="Language" icon={<Languages className="size-3.5" aria-hidden />}>
                {language ? <span className="text-muted">{language}</span> : <Muted>Not set</Muted>}
              </Field>
            </dl>
          </Card>
        </div>
      ) : tab === 'world' ? (
        <WorldPanel projectId={project.id} />
      ) : tab === 'characters' ? (
        <CharactersPanel projectId={project.id} />
      ) : tab === 'narrative' ? (
        <NarrativePanel projectId={project.id} />
      ) : tab === 'outline' ? (
        <OutlinePanel projectId={project.id} />
      ) : (
        <div className="space-y-4">
          {/* Chapter manuscripts and scene prose are independent prose streams
              in the data model, so they get separate editors rather than one
              mixed surface (which would let two autosave targets collide). */}
          <div
            role="tablist"
            aria-label="Writing view"
            className="flex items-center gap-1 overflow-x-auto"
          >
            {WRITING_VIEWS.map((view) => {
              const selected = writingView === view.id;
              return (
                <button
                  key={view.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setWritingView(view.id)}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                    selected
                      ? 'bg-surface-muted text-ink'
                      : 'text-muted hover:bg-surface-muted hover:text-ink',
                  )}
                >
                  {view.icon}
                  {view.label}
                </button>
              );
            })}
          </div>
          {writingView === 'chapters' ? (
            <WritingPanel projectId={project.id} />
          ) : (
            <ScenesProsePanel projectId={project.id} />
          )}
        </div>
      )}

      {/* Edit dialog reuses the shared form; initialProject pre-fills it and
          switches it into edit mode. The hook refreshes the page on success. */}
      <ProjectFormDialog
        open={editOpen}
        initialProject={project}
        onSubmit={handleEditSubmit}
        onClose={() => setEditOpen(false)}
      />

      {/* Delete confirm dialog. Cancel/Escape close it without deleting; on
          success we navigate away, on failure the dialog stays open. Deleting a
          project also cascades to its world and characters (see ProjectService). */}
      <DeleteProjectDialog
        open={deleteOpen}
        projectTitle={project.title}
        onConfirm={handleDelete}
        onClose={() => setDeleteOpen(false)}
      />
    </div>
  );
}

function ProjectNotFound({ projectId }: { projectId?: string }) {
  return (
    <Card padding="lg" className="flex flex-col items-center text-center">
      <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
        <FileX2 className="size-5" aria-hidden />
      </span>
      <h3 className="text-ink text-sm font-semibold">Project not found</h3>
      <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
        {projectId ? (
          <>
            No project with the id <code className="bg-surface-muted rounded px-1 py-0.5 text-2xs">{projectId}</code>{' '}
            exists. It may have been deleted, or the link may be incorrect.
          </>
        ) : (
          'No project id was provided.'
        )}
      </p>
      <ButtonLink
        variant="primary"
        size="sm"
        className="mt-4"
        to="/projects"
        iconLeft={<ArrowLeft className="size-3.5" />}
      >
        Back to My Projects
      </ButtonLink>
    </Card>
  );
}

function Field({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-subtle flex items-center gap-1 text-2xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-subtle italic">{children}</span>;
}
