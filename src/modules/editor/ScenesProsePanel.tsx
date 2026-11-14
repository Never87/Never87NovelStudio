import { useEffect, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { Card, EmptyState } from '@/components/ui';
import { useOutline, useScenes } from '@/hooks';
import { cn } from '@/utils/cn';
import { SceneEditorSurface } from './SceneEditorSurface';

export interface ScenesProsePanelProps {
  projectId: string;
}

/**
 * "Scenes" view of the Writing tab: scene-level prose.
 *
 * Chapter manuscripts (WritingPanel) and scene manuscripts are SEPARATE prose
 * streams in the data model, so they live in separate editors. Mixing them in
 * one surface would let two autosave targets overwrite each other.
 *
 * Data: `useOutline` flattens the chapter list for the picker; `useScenes` loads
 * the selected chapter's scenes. Selecting a scene mounts `SceneEditorSurface`,
 * which owns that scene's autosave lifecycle.
 */
export function ScenesProsePanel({ projectId }: ScenesProsePanelProps) {
  const { outline, status: outlineStatus, loading } = useOutline(projectId);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [sceneId, setSceneId] = useState<string | null>(null);

  const chapters = outline.flatMap((entry) => entry.chapters);

  // Default to the first chapter (never a dead end).
  useEffect(() => {
    if (!chapterId && chapters.length > 0) setChapterId(chapters[0].id);
  }, [chapterId, chapters]);

  const { scenes, status: scenesStatus } = useScenes(projectId, chapterId ?? undefined);

  // Keep the selected scene valid as chapters/scenes change.
  useEffect(() => {
    if (sceneId && !scenes.some((scene) => scene.id === sceneId)) setSceneId(scenes[0]?.id ?? null);
  }, [sceneId, scenes]);

  if (outlineStatus === 'error') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">
          The outline could not be loaded, so scene prose is unavailable.
        </p>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card padding="lg">
        <p className="text-subtle text-xs" role="status">
          Loading scenes...
        </p>
      </Card>
    );
  }

  if (chapters.length === 0) {
    return (
      <EmptyState
        icon={<Clapperboard className="size-5" aria-hidden />}
        title="No chapters to write scenes for"
        description="Scenes live inside chapters. Create a chapter in the Outline tab first, then break it into scenes."
      />
    );
  }

  const selectedScene = scenes.find((scene) => scene.id === sceneId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-ink text-sm font-semibold">Scene prose</h2>
        <span className="text-subtle text-2xs">
          {scenes.length} scene{scenes.length === 1 ? '' : 's'} in this chapter
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <Card padding="sm" className="h-fit space-y-3">
          <div>
            <p className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">Chapter</p>
            <select
              value={chapterId ?? ''}
              onChange={(event) => setChapterId(event.target.value || null)}
              aria-label="Select chapter"
              className="bg-surface border-line-strong text-ink focus-visible:outline-accent h-8 w-full rounded-md border px-2 text-xs focus-visible:outline-2"
            >
              {chapters.map((chapter) => (
                <option key={chapter.id} value={chapter.id}>
                  {chapter.order + 1}. {chapter.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-subtle mb-1 text-2xs font-medium uppercase tracking-wide">Scene</p>
            {scenesStatus === 'error' ? (
              <p className="text-danger text-2xs" role="alert">
                Failed to load scenes.
              </p>
            ) : scenes.length === 0 ? (
              <p className="text-subtle text-2xs italic">No scenes in this chapter yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {scenes.map((scene) => {
                  const active = scene.id === sceneId;
                  return (
                    <li key={scene.id}>
                      <button
                        type="button"
                        onClick={() => setSceneId(scene.id)}
                        aria-current={active ? 'true' : undefined}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                          active
                            ? 'bg-accent/10 text-ink font-medium'
                            : 'text-muted hover:bg-surface-muted hover:text-ink',
                        )}
                      >
                        <span className="text-subtle w-4 shrink-0 tabular-nums">{scene.order + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{scene.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>

        {selectedScene ? (
          <SceneEditorSurface
            key={selectedScene.id}
            projectId={projectId}
            sceneId={selectedScene.id}
            sceneTitle={selectedScene.title}
            sceneOrder={selectedScene.order}
          />
        ) : (
          <Card padding="lg" className="flex flex-col items-center justify-center text-center">
            <span className="bg-surface text-subtle border-line mb-3 grid size-11 place-items-center rounded-lg border">
              <Clapperboard className="size-5" aria-hidden />
            </span>
            <h3 className="text-ink text-sm font-semibold">No scene selected</h3>
            <p className="text-muted mt-1 max-w-md text-xs leading-relaxed">
              Add scenes to this chapter in the Outline tab, then select one here to write its
              prose. Scene prose autosaves separately from the chapter manuscript.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
