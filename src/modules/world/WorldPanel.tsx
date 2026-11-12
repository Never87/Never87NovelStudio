import { useState } from 'react';
import {
  CalendarClock,
  Globe2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Badge, Button, Card } from '@/components/ui';
import type { World } from '@/types';
import { useWorld } from '@/hooks';
import type { CreateWorldInput, UpdateWorldInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { CardHeader } from '@/components/ui';
import { formatDate } from '@/modules/projects/project-meta';
import { WorldFormDialog } from './components/WorldFormDialog';

/**
 * World-building section of the project detail page.
 *
 * One world per project. States: loading / error / empty (create CTA) /
 * populated (sections + edit/delete). All data flows through `useWorld`.
 */
export function WorldPanel({ projectId }: { projectId: string }) {
  const { world, status, loading, isEmpty, error, refresh, createWorld, updateWorld, deleteWorld } =
    useWorld(projectId);

  const [formOpen, setFormOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleCreate = async (input: CreateWorldInput | UpdateWorldInput) => {
    await createWorld(input as CreateWorldInput);
  };

  const handleUpdate = async (input: CreateWorldInput | UpdateWorldInput) => {
    await updateWorld(input as UpdateWorldInput);
  };

  const handleDelete = async () => {
    await deleteWorld();
  };

  if (status === 'loading' && loading) {
    return (
      <Card padding="lg">
        <div
          className="text-subtle flex items-center justify-center gap-2 py-8 text-xs"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Loading world…
        </div>
      </Card>
    );
  }

  if (status === 'error') {
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : 'Error';
    return (
      <Card padding="lg" className="flex flex-col items-center text-center" role="alert">
        <span className="bg-danger-soft text-danger grid size-10 place-items-center rounded-lg">
          <TriangleAlert className="size-5" aria-hidden />
        </span>
        <h3 className="text-ink mt-3 text-sm font-semibold">Couldn’t load the world</h3>
        <p className="text-muted mt-1 max-w-md text-xs">
          Something went wrong while reading this project’s world. Your data has not been changed.
        </p>
        <pre className="bg-surface-muted text-subtle mt-3 max-h-24 w-full max-w-md overflow-auto rounded-md p-2 text-2xs whitespace-pre-wrap break-words">
          {name}: {message}
        </pre>
        <Button
          variant="primary"
          size="sm"
          className="mt-4"
          iconLeft={<RefreshCw className="size-3.5" />}
          onClick={() => void refresh()}
        >
          Retry
        </Button>
      </Card>
    );
  }

  if (isEmpty || !world) {
    return (
      <Card padding="lg" className="flex flex-col items-center text-center">
        <span className="bg-surface text-subtle mb-3 grid size-11 place-items-center rounded-lg border border-line">
          <Globe2 className="size-5" aria-hidden />
        </span>
        <h3 className="text-ink text-sm font-semibold">Your world is waiting to be built</h3>
        <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
          Define the setting once and reference it everywhere — geography, history, factions and the
          rules that hold your story together.
        </p>
        <Button
          variant="primary"
          size="sm"
          className="mt-4"
          iconLeft={<Plus className="size-3.5" />}
          onClick={() => setFormOpen(true)}
        >
          Create world
        </Button>
        <WorldFormDialog
          open={formOpen}
          onSubmit={handleCreate}
          onClose={() => setFormOpen(false)}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card padding="md">
        <CardHeader
          icon={<Globe2 className="size-4" aria-hidden />}
          title={world.title}
          description={
            world.settings.era ? `${world.settings.era}` : 'No era specified'
          }
          action={
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                iconLeft={<Pencil className="size-3.5" />}
                onClick={() => setFormOpen(true)}
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
        />

        {world.overview ? (
          <p className="text-muted mt-3 text-sm whitespace-pre-line">{world.overview}</p>
        ) : (
          <p className="text-subtle mt-3 text-xs italic">No overview yet.</p>
        )}

        <div className="border-line mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t pt-3 text-2xs">
          <span className="text-subtle flex items-center gap-1">
            <CalendarClock className="size-3.5" aria-hidden />
            Updated {formatDate(world.updatedAt)}
          </span>
          {world.settings.technology ? (
            <span className="text-muted flex items-center gap-1">
              <Sparkles className="size-3.5" aria-hidden />
              {world.settings.technology}
            </span>
          ) : null}
          {world.themes.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1">
              {world.themes.map((theme) => (
                <Badge key={theme} tone="neutral" size="sm">
                  {theme}
                </Badge>
              ))}
            </span>
          ) : null}
        </div>
      </Card>

      <WorldSectionsList world={world} onEdit={() => setFormOpen(true)} />

      <WorldFormDialog
        open={formOpen}
        initialWorld={world}
        onSubmit={handleUpdate}
        onClose={() => setFormOpen(false)}
      />

      <ProjectDialog
        open={deleteOpen}
        title="Delete world?"
        description="This removes this project's world and all of its sections."
        tone="danger"
        dismissible
        onClose={() => setDeleteOpen(false)}
        footer={
          <DeleteWorldFooter
            onCancel={() => setDeleteOpen(false)}
            onConfirm={handleDelete}
            onDone={() => setDeleteOpen(false)}
          />
        }
      >
        <p className="text-muted text-xs">
          The world will be permanently removed. This cannot be undone. Your characters and project
          details are not affected.
        </p>
      </ProjectDialog>
    </div>
  );
}

/** Ordered, read-only list of the world's sections. */
function WorldSectionsList({ world, onEdit }: { world: World; onEdit: () => void }) {
  if (world.sections.length === 0) {
    return (
      <Card padding="md" className="flex flex-col items-center text-center">
        <h3 className="text-ink text-sm font-semibold">No sections yet</h3>
        <p className="text-muted mt-1 max-w-md text-xs">
          Add named sections such as geography, history or factions to organise your world.
        </p>
        <Button variant="secondary" size="sm" className="mt-3" iconLeft={<Plus className="size-3.5" />} onClick={onEdit}>
          Add sections
        </Button>
      </Card>
    );
  }

  return (
    <ul className="space-y-3">
      {world.sections.map((section, index) => (
        <li key={section.id}>
          <Card padding="md">
            <div className="flex items-start gap-2.5">
              <span className="bg-surface-muted text-subtle grid size-6 shrink-0 place-items-center rounded text-2xs font-semibold">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-ink text-sm font-semibold break-words">{section.title}</h3>
                {section.content ? (
                  <p className="text-muted mt-1 text-xs whitespace-pre-line">{section.content}</p>
                ) : (
                  <p className="text-subtle mt-1 text-xs italic">No content yet.</p>
                )}
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** Delete confirmation with its own in-flight / error state. */
function DeleteWorldFooter({
  onCancel,
  onConfirm,
  onDone,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
      onDone();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2">
      {failure ? (
        <p className="text-danger text-2xs" role="alert">
          {failure}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" size="sm" loading={busy} onClick={() => void run()}>
          Delete world
        </Button>
      </div>
    </div>
  );
}
