import { useEffect, useState } from 'react';
import { AlertTriangle, Check, MapPin, Save } from 'lucide-react';
import { Badge, Button, Card, IconButton } from '@/components/ui';
import { countWords } from '@/utils/manuscript-text';
import { formatRelative } from '@/utils/date';
import { MarkdownEditor } from './MarkdownEditor';
import { useSceneEditor } from './use-scene-editor';

export interface SceneEditorSurfaceProps {
  projectId: string;
  sceneId: string;
  /** Title shown in the header and used as the editor's accessible name. */
  sceneTitle: string;
  sceneOrder: number;
}

/**
 * Scene manuscript editor (P4 follow-up).
 *
 * The scene counterpart of the chapter editor surface: same autosave contract
 * (`useSceneEditor` -> `AutosaveEngine` -> `manuscriptService.saveSceneDraft`),
 * same derived word count, same status pill. Intentionally leaner - scenes have
 * no version dialog or prev/next navigation here.
 *
 * Scenes are never locked by status (only `final` chapters lock writes), so the
 * surface is always editable.
 */
export function SceneEditorSurface({
  projectId,
  sceneId,
  sceneTitle,
  sceneOrder,
}: SceneEditorSurfaceProps) {
  const { document, status, error, autosave, onChange, saveNow, retry, reload } =
    useSceneEditor(projectId, sceneId);

  // Live counter mirrors the derived count the Service persists.
  const [liveWords, setLiveWords] = useState(0);
  useEffect(() => {
    if (document) setLiveWords(document.wordCount);
  }, [document]);

  if (status === 'not-found') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">This scene no longer exists. Pick another one.</p>
      </Card>
    );
  }

  if (status === 'error') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">The scene manuscript could not be loaded.</p>
        <p className="text-subtle mt-1 text-xs">{error instanceof Error ? error.message : ''}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => void reload()}>
          Retry
        </Button>
      </Card>
    );
  }

  if (!document) {
    return (
      <Card padding="lg">
        <p className="text-subtle text-xs" role="status">
          Opening scene...
        </p>
      </Card>
    );
  }

  const handleChange = (markdown: string) => {
    onChange(markdown);
    setLiveWords(countWords(markdown));
  };

  const location = document.scene.location.trim();

  return (
    <Card padding="none" className="flex min-h-[420px] flex-col overflow-hidden">
      <div className="border-line flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-subtle shrink-0 text-2xs tabular-nums">{sceneOrder + 1}</span>
          <h3 className="text-ink truncate text-sm font-semibold">{document.scene.title}</h3>
          {location ? (
            <Badge tone="neutral" size="sm">
              <MapPin className="mr-1 size-3" aria-hidden />
              {location}
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-subtle text-2xs tabular-nums">
            {liveWords.toLocaleString()} words
          </span>
          <SceneAutosavePill autosave={autosave} onRetry={() => void retry()} />
          <IconButton
            label="Save scene now"
            icon={<Save className="size-3.5" aria-hidden />}
            onClick={() => void saveNow()}
          />
        </div>
      </div>

      <MarkdownEditor
        editorKey={document.scene.title}
        value={document.content}
        onChange={handleChange}
        ariaLabel={`Scene manuscript: ${sceneTitle}`}
        onSaveShortcut={() => void saveNow()}
        className="min-h-0 flex-1"
      />
    </Card>
  );
}

/** Compact autosave pill for scenes (mirrors the chapter pill). */
function SceneAutosavePill({
  autosave,
  onRetry,
}: {
  autosave: ReturnType<typeof useSceneEditor>['autosave'];
  onRetry: () => void;
}) {
  if (autosave.status === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="text-danger hover:bg-danger/10 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs"
        title={autosave.error instanceof Error ? autosave.error.message : 'Save failed'}
      >
        <AlertTriangle className="size-3" aria-hidden />
        Save failed - retry
      </button>
    );
  }

  if (autosave.status === 'saving') {
    return (
      <span className="text-subtle inline-flex items-center gap-1 text-2xs" role="status">
        <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
        Saving...
      </span>
    );
  }

  if (autosave.dirty) {
    return (
      <span className="text-subtle text-2xs" role="status">
        Unsaved changes
      </span>
    );
  }

  if (autosave.status === 'saved') {
    return (
      <span className="text-success inline-flex items-center gap-1 text-2xs" role="status">
        <Check className="size-3" aria-hidden />
        Saved{autosave.lastSavedAt ? ` ${formatRelative(autosave.lastSavedAt)}` : ''}
      </span>
    );
  }

  return null;
}
