import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Badge, Button, Card, IconButton } from '@/components/ui';
import type { Character, Scene } from '@/types';
import { useScenes } from '@/hooks';
import type { CreateSceneInput, UpdateSceneInput } from '@/services';
import { ProjectDialog } from '@/modules/projects/components/ProjectDialog';
import { describeError } from '@/modules/projects/components/ProjectFormDialog';
import { SCENE_PURPOSE_META, SCENE_STATUS_META, formatWords } from '../outline-meta';
import { SceneFormDialog } from './SceneFormDialog';

export interface ScenesPanelProps {
  projectId: string;
  chapterId: string;
  characters: Character[];
}

/**
 * Scene list for ONE chapter.
 *
 * Ordered scenes with reorder / edit / delete. All data flows through
 * `useScenes(projectId, chapterId)`, which re-verifies the chapter belongs to
 * the project before writing.
 */
export function ScenesPanel({ projectId, chapterId, characters }: ScenesPanelProps) {
  const {
    scenes,
    status,
    loading,
    isEmpty,
    error,
    refresh,
    createScene,
    updateScene,
    moveScene,
    deleteScene,
  } = useScenes(projectId, chapterId);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Scene | null>(null);
  const [deleting, setDeleting] = useState<Scene | null>(null);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (scene: Scene) => {
    setEditing(scene);
    setFormOpen(true);
  };

  if (status === 'loading' && loading) {
    return (
      <div className="text-subtle flex items-center justify-center gap-2 py-6 text-xs" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading scenes…
      </div>
    );
  }

  if (status === 'error') {
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div role="alert" className="border-danger/30 bg-danger-soft text-danger rounded-md border p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <TriangleAlert className="size-3.5" aria-hidden />
          Couldn’t load scenes
        </div>
        <p className="mt-1 text-2xs whitespace-pre-wrap break-words">{message}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          iconLeft={<RefreshCw className="size-3.5" />}
          onClick={() => void refresh()}
        >
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-subtle text-2xs">
          {isEmpty ? 'No scenes yet' : `${scenes.length} scene${scenes.length === 1 ? '' : 's'}`}
        </p>
        <Button variant="secondary" size="sm" iconLeft={<Plus className="size-3.5" />} onClick={openCreate}>
          Add scene
        </Button>
      </div>

      {isEmpty ? (
        <div className="border-line rounded-md border border-dashed p-4 text-center">
          <Clapperboard className="text-subtle mx-auto size-5" aria-hidden />
          <p className="text-muted mt-1.5 text-xs">Break this chapter into scenes.</p>
          <p className="text-subtle text-2xs">Goal → conflict → turning point → outcome.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {scenes.map((scene, index) => {
            const purpose = SCENE_PURPOSE_META[scene.purpose];
            const sceneStatus = SCENE_STATUS_META[scene.status];
            return (
              <li key={scene.id}>
                <Card padding="sm" className="border-line border">
                  <div className="flex items-start gap-2">
                    <span className="bg-surface-muted text-subtle mt-0.5 grid size-5 shrink-0 place-items-center rounded text-2xs font-semibold">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h4 className="text-ink text-xs font-semibold break-words">{scene.title}</h4>
                        <Badge tone={purpose.tone} size="sm">
                          {purpose.label}
                        </Badge>
                        <Badge tone={sceneStatus.tone} size="sm" dot>
                          {sceneStatus.label}
                        </Badge>
                        {typeof scene.targetWords === 'number' ? (
                          <span className="text-subtle text-2xs">{formatWords(scene.targetWords)} words</span>
                        ) : null}
                      </div>

                      {scene.summary.trim() ? (
                        <p className="text-muted mt-1 line-clamp-2 text-2xs">{scene.summary}</p>
                      ) : null}

                      {scene.location.trim() || scene.timeOfDay.trim() ? (
                        <p className="text-subtle mt-1 flex items-center gap-1 text-2xs">
                          <MapPin className="size-3" aria-hidden />
                          {[scene.location, scene.timeOfDay].filter(Boolean).join(' · ')}
                        </p>
                      ) : null}

                      {scene.goal.trim() || scene.outcome.trim() ? (
                        <dl className="text-2xs mt-1.5 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
                          {scene.goal.trim() ? (
                            <div className="min-w-0">
                              <dt className="text-subtle inline font-medium">Goal: </dt>
                              <dd className="text-muted inline">{truncate(scene.goal, 90)}</dd>
                            </div>
                          ) : null}
                          {scene.outcome.trim() ? (
                            <div className="min-w-0">
                              <dt className="text-subtle inline font-medium">Outcome: </dt>
                              <dd className="text-muted inline">{truncate(scene.outcome, 90)}</dd>
                            </div>
                          ) : null}
                        </dl>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Move scene ${index + 1} up`}
                        icon={<ArrowUp className="size-3.5" aria-hidden />}
                        onClick={() => void moveScene(scene.id, -1)}
                        disabled={index === 0}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Move scene ${index + 1} down`}
                        icon={<ArrowDown className="size-3.5" aria-hidden />}
                        onClick={() => void moveScene(scene.id, 1)}
                        disabled={index === scenes.length - 1}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Edit scene ${scene.title}`}
                        icon={<Pencil className="size-3.5" aria-hidden />}
                        onClick={() => openEdit(scene)}
                      />
                      <IconButton
                        variant="ghost"
                        size="sm"
                        label={`Delete scene ${scene.title}`}
                        icon={<Trash2 className="size-3.5" aria-hidden />}
                        onClick={() => setDeleting(scene)}
                      />
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <SceneFormDialog
        open={formOpen && editing === null}
        characters={characters}
        onSubmit={async (input) => {
          await createScene(input as CreateSceneInput);
        }}
        onClose={() => setFormOpen(false)}
      />
      <SceneFormDialog
        key={editing?.id ?? 'edit'}
        open={formOpen && editing !== null}
        initialScene={editing}
        characters={characters}
        onSubmit={async (input) => {
          if (editing) await updateScene(editing.id, input as UpdateSceneInput);
        }}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
      />

      <ProjectDialog
        open={deleting !== null}
        title="Delete scene?"
        description={deleting ? `“${deleting.title}” will be permanently removed.` : undefined}
        tone="danger"
        onClose={() => setDeleting(null)}
        footer={
          <DeleteSceneFooter
            onCancel={() => setDeleting(null)}
            onConfirm={async () => {
              if (deleting) await deleteScene(deleting.id);
            }}
            onDone={() => setDeleting(null)}
          />
        }
      >
        <p className="text-muted text-xs">This removes the scene from this chapter. It cannot be undone.</p>
      </ProjectDialog>
    </div>
  );
}

function truncate(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max).trimEnd()}…`;
}

function DeleteSceneFooter({
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
          Delete scene
        </Button>
      </div>
    </div>
  );
}
