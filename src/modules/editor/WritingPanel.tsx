import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Lock,
  Save,
  Upload,
} from 'lucide-react';
import { Badge, Button, Card, EmptyState, IconButton } from '@/components/ui';
import { useOutline } from '@/hooks';
import type { DraftVersion } from '@/types';
import { manuscriptService } from '@/services';
import { cn } from '@/utils/cn';
import { formatRelative } from '@/utils/date';
import { countWords, excerpt } from '@/utils/manuscript-text';
import { MarkdownEditor } from './MarkdownEditor';
import { EditorAiAssistant } from '@/modules/ai/EditorAiAssistant';
import { useChapterEditor } from './use-chapter-editor';
import { VersionHistoryDialog } from './VersionHistoryDialog';
import { ImportExportDialog } from './ImportExportDialog';

export interface WritingPanelProps {
  projectId: string;
}

/**
 * Writing tab (P4): the chapter manuscript editor.
 *
 * Layout: a chapter list on the left (prose progress per chapter), the editor
 * on the right with a live word count and autosave status in the header.
 *
 * The editor never owns persistence — every keystroke goes through
 * `useChapterEditor`, which debounces, serialises and revision-checks the save.
 */
export function WritingPanel({ projectId }: WritingPanelProps) {
  const { outline, status: outlineStatus, loading } = useOutline(projectId);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);

  const chapters = outline.flatMap((entry) => entry.chapters);

  // Open the first chapter by default so the tab is never a dead end.
  useEffect(() => {
    if (!chapterId && chapters.length > 0) setChapterId(chapters[0].id);
  }, [chapterId, chapters]);

  // If the open chapter disappears (deleted in another tab), fall back.
  useEffect(() => {
    if (chapterId && !chapters.some((chapter) => chapter.id === chapterId)) {
      setChapterId(chapters[0]?.id ?? null);
    }
  }, [chapterId, chapters]);

  if (outlineStatus === 'error') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">
          The outline could not be loaded, so the editor is unavailable.
        </p>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card padding="lg">
        <p className="text-subtle text-xs" role="status">
          Loading chapters…
        </p>
      </Card>
    );
  }

  if (chapters.length === 0) {
    return (
      <EmptyState
        icon={<BookOpen className="size-5" aria-hidden />}
        title="No chapters to write yet"
        description="The editor writes into chapters. Create a chapter in the Outline tab first — or import a Markdown draft to create them in bulk."
        action={
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Upload className="size-3.5" />}
            onClick={() => setTransferOpen(true)}
          >
            Import Markdown
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-ink text-sm font-semibold">Manuscript</h2>
          <span className="text-subtle text-2xs">{chapters.length} chapters</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<History className="size-3.5" />}
            onClick={() => setHistoryOpen(true)}
            disabled={!chapterId}
          >
            Versions
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<Download className="size-3.5" />}
            onClick={() => setTransferOpen(true)}
          >
            Import / Export
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <ChapterNav
          outline={outline}
          activeChapterId={chapterId}
          onSelect={(id) => setChapterId(id)}
        />
        {chapterId ? (
          <ChapterEditorSurface
            projectId={projectId}
            chapterId={chapterId}
            siblings={chapters}
            onOpenChapter={setChapterId}
            historyOpen={historyOpen}
            onHistoryOpenChange={setHistoryOpen}
          />
        ) : null}
      </div>

      <ImportExportDialog
        open={transferOpen}
        projectId={projectId}
        onClose={() => setTransferOpen(false)}
      />
    </div>
  );
}

/** Left rail: volumes, their chapters, and per-chapter prose progress. */
function ChapterNav({
  outline,
  activeChapterId,
  onSelect,
}: {
  outline: ReturnType<typeof useOutline>['outline'];
  activeChapterId: string | null;
  onSelect: (chapterId: string) => void;
}) {
  return (
    <Card padding="sm" className="h-fit">
      <div className="space-y-3">
        {outline.map(({ volume, chapters }) => (
          <div key={volume.id}>
            <p className="text-subtle mb-1 truncate text-2xs font-medium uppercase tracking-wide">
              {volume.title}
            </p>
            <ul className="space-y-0.5">
              {chapters.map((chapter) => {
                const active = chapter.id === activeChapterId;
                const locked = chapter.status === 'final';
                return (
                  <li key={chapter.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(chapter.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                        active
                          ? 'bg-accent/10 text-ink font-medium'
                          : 'text-muted hover:bg-surface-muted hover:text-ink',
                      )}
                    >
                      <span className="text-subtle w-4 shrink-0 tabular-nums">
                        {chapter.order + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{chapter.title}</span>
                      {locked ? (
                        <Lock className="text-subtle size-3 shrink-0" aria-label="Locked" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
              {chapters.length === 0 ? (
                <li className="text-subtle px-2 text-2xs italic">Empty volume</li>
              ) : null}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Editor + header for the open chapter. */
function ChapterEditorSurface({
  projectId,
  chapterId,
  siblings,
  onOpenChapter,
  historyOpen,
  onHistoryOpenChange,
}: {
  projectId: string;
  chapterId: string;
  siblings: Array<{ id: string; title: string }>;
  onOpenChapter: (chapterId: string) => void;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
}) {
  const { document, status, error, autosave, onChange, saveNow, retry, reload, createVersion } =
    useChapterEditor(projectId, chapterId);

  // Live counter mirrors the derived count the Service will persist, so the
  // number on screen and the number stored always agree.
  const [liveWords, setLiveWords] = useState(0);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    if (document) setLiveWords(document.draft.wordCount);
  }, [document]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    void manuscriptService
      .listVersions(document.draft.id)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch(() => {
        if (!cancelled) setVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [document, autosave.lastSavedAt]);

  if (status === 'not-found') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">This chapter no longer exists. Pick another one.</p>
      </Card>
    );
  }

  if (status === 'error') {
    return (
      <Card padding="lg">
        <p className="text-muted text-sm">The manuscript could not be loaded.</p>
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
          Opening chapter…
        </p>
      </Card>
    );
  }

  const index = siblings.findIndex((chapter) => chapter.id === chapterId);
  const previous = index > 0 ? siblings[index - 1] : null;
  const next = index >= 0 && index < siblings.length - 1 ? siblings[index + 1] : null;
  const locked = document.locked;

  const handleChange = (markdown: string) => {
    onChange(markdown);
    setLiveWords(countWords(markdown));
  };

  return (
    <Card padding="none" className="flex min-h-[520px] flex-col overflow-hidden">
      {/* Editor header: title, counts, autosave status, actions */}
      <div className="border-line flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-subtle shrink-0 text-2xs tabular-nums">
            {document.chapterOrder + 1}
          </span>
          <h3 className="text-ink truncate text-sm font-semibold">{document.title}</h3>
          {locked ? (
            <Badge tone="warning" size="sm" dot>
              <Lock className="mr-1 size-3" aria-hidden />
              Locked
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-subtle text-2xs tabular-nums">
            {liveWords.toLocaleString()} words
            {document.projectWordCount > 0 ? (
              <span className="text-subtle/70"> · project {document.projectWordCount.toLocaleString()}</span>
            ) : null}
          </span>
          <AutosaveIndicator autosave={autosave} onRetry={() => void retry()} />
          <IconButton
            label="Save now"
            icon={<Save className="size-3.5" aria-hidden />}
            onClick={() => void saveNow()}
            disabled={locked}
          />
          <div className="flex items-center gap-0.5">
            <IconButton
              label="Previous chapter"
              icon={<ChevronLeft className="size-4" aria-hidden />}
              onClick={() => previous && onOpenChapter(previous.id)}
              disabled={!previous}
            />
            <IconButton
              label="Next chapter"
              icon={<ChevronRight className="size-4" aria-hidden />}
              onClick={() => next && onOpenChapter(next.id)}
              disabled={!next}
            />
          </div>
        </div>
      </div>

      {locked ? (
        <div className="border-line bg-surface-muted/50 text-muted flex items-center gap-2 border-b px-4 py-2 text-xs">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          This chapter is marked <strong className="text-ink">Final</strong>, which locks it. Set a
          different status in the Outline tab to edit again.
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <MarkdownEditor
          key={`${chapterId}:${document.draft.revision === 0 ? 'new' : 'open'}`}
          editorKey={document.draft.id}
          value={document.draft.content}
          onChange={handleChange}
          editable={!locked}
          onSaveShortcut={() => void saveNow()}
          onEditorReady={setEditor}
          className="min-h-0 flex-1"
        />
        <aside className="border-line w-full shrink-0 border-t p-3 lg:w-64 lg:border-t-0 lg:border-l">
          <EditorAiAssistant editor={editor} chapterTitle={document.title} locked={locked} />
        </aside>
      </div>

      <VersionHistoryDialog
        open={historyOpen}
        versions={versions}
        onClose={() => onHistoryOpenChange(false)}
        onCreateVersion={async (label) => {
          await createVersion(label);
        }}
        onRestore={async (versionId) => {
          await manuscriptService.restoreVersion(versionId);
          await reload();
        }}
      />
    </Card>
  );
}

/** Compact autosave pill: saved / saving / unsaved / error. */
function AutosaveIndicator({
  autosave,
  onRetry,
}: {
  autosave: ReturnType<typeof useChapterEditor>['autosave'];
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
        Save failed — retry
      </button>
    );
  }

  if (autosave.status === 'saving') {
    return (
      <span className="text-subtle inline-flex items-center gap-1 text-2xs" role="status">
        <span className="bg-accent size-1.5 animate-pulse rounded-full" aria-hidden />
        Saving…
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

/** Re-exported for tests: renders the excerpt used by import previews. */
export const __previewExcerpt = excerpt;
